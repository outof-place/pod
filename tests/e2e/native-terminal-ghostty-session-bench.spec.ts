import type { Page } from '@stablyai/playwright-test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import {
  enableNativeTerminal,
  findNativeSurfaceForPane,
  isNativeSurfaceHidden,
  nativeTerminalDebug,
  xtermScreenTransform
} from './helpers/native-terminal-debug'
import {
  idleRatesBetween,
  openTerminalTab,
  usageSnapshot,
  type ProcessKind
} from './helpers/native-terminal-process-usage'
import {
  removeDialog,
  setNativeTerminalParseOnce,
  showDialogOverPane,
  waitForNativeShellReady
} from './helpers/native-terminal-parse-once'
import { sendToTerminal, waitForActivePanePtyId } from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForPtyShellEcho } from './terminal-pty-readiness'
import { nodeTerminalCommand } from './terminal-node-command'

// A long agent session in one pane: recorded Codex turns (bytes and pacing exactly as captured,
// back to back), with the views' catch-up triggers a user causes every few minutes: a dialog
// over the pane, then a switch to another tab and back. Reports instructions and CPU per
// process kind for one mode per run. Opt-in, not a gate.
//   ORCA_NATIVE_TERMINAL_SESSION_BENCH=1 ORCA_NATIVE_TERMINAL_SESSION_MODE=native-parse-once \
//   ORCA_NATIVE_TERMINAL_SESSION_MINUTES=30 SKIP_BUILD=1 pnpm run test:e2e \
//   tests/e2e/native-terminal-ghostty-session-bench.spec.ts

type Mode = 'xterm' | 'native' | 'native-parse-once'

const enabled = process.env.ORCA_NATIVE_TERMINAL_SESSION_BENCH === '1'
const modeSetting = process.env.ORCA_NATIVE_TERMINAL_SESSION_MODE ?? 'native-parse-once'
const minutes = Number(process.env.ORCA_NATIVE_TERMINAL_SESSION_MINUTES ?? 30)
const triggerEveryMs = Number(process.env.ORCA_NATIVE_TERMINAL_SESSION_TRIGGER_MS ?? 180_000)
const DIALOG_MS = 5_000
const AWAY_MS = 10_000
const TURNS = [
  'codex-0-155-1-timed-turn',
  'codex-0-157-1-timed-sleep-turn',
  'codex-0-158-0-timed-turn'
]
const FIXTURES = path.resolve(__dirname, '../../src/main/runtime/__fixtures__')

test.use({ trace: 'off', screenshot: 'off' })
test.skip(process.platform !== 'darwin', 'the native Ghostty terminal is macOS only')
test.skip(!enabled, 'Opt-in benchmark: set ORCA_NATIVE_TERMINAL_SESSION_BENCH=1')

function isMode(value: string): value is Mode {
  return value === 'xterm' || value === 'native' || value === 'native-parse-once'
}

// Replays the turns at their recorded offsets, in order, until `minutes` are up.
function writeReplayScript(file: string, done: string): void {
  const turns = TURNS.map((name) => ({
    text: path.join(FIXTURES, `${name}.txt`),
    timing: path.join(FIXTURES, `${name}.timing.json`)
  }))
  writeFileSync(
    file,
    `const fs = require('fs')
const turns = ${JSON.stringify(turns)}.map((turn) => ({
  text: fs.readFileSync(turn.text, 'utf8'),
  chunks: JSON.parse(fs.readFileSync(turn.timing, 'utf8')).chunks
}))
// Why raw: replies to the transcript's own queries must not echo into the replay.
process.stdin.setRawMode(true)
process.stdin.resume()
const deadline = Date.now() + ${minutes} * 60_000
let chars = 0
let replayedTurns = 0
const playTurn = (index) => {
  if (Date.now() >= deadline) {
    fs.writeFileSync(${JSON.stringify(done)}, JSON.stringify({ chars, turns: replayedTurns }))
    process.stdout.write('\\x1b[?1049l\\x1b[0m\\r\\nREPLAY-DONE\\r\\n')
    process.exit(0)
  }
  const turn = turns[index % turns.length]
  const startedAt = Date.now()
  let offset = 0
  let next = 0
  const step = () => {
    const elapsed = Date.now() - startedAt
    while (next < turn.chunks.length && turn.chunks[next][0] <= elapsed) {
      const chunk = turn.text.slice(offset, offset + turn.chunks[next][1])
      offset += turn.chunks[next][1]
      chars += chunk.length
      process.stdout.write(chunk)
      next += 1
    }
    if (next >= turn.chunks.length) {
      replayedTurns += 1
      setImmediate(() => playTurn(index + 1))
      return
    }
    setTimeout(step, Math.max(0, turn.chunks[next][0] - elapsed))
  }
  step()
}
playTurn(0)
`
  )
}

async function setActiveTab(page: Page, tabId: string): Promise<void> {
  await page.evaluate((id) => window.__store?.getState().setActiveTab(id), tabId)
  await expect
    .poll(async () => page.evaluate(() => window.__store?.getState().activeTabId))
    .toBe(tabId)
}

type KindTotal = { instructions: number; cpuMs: number; footprintMb: number }

test('a long agent session: instructions and CPU per process kind', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  if (!isMode(modeSetting)) {
    throw new Error(`Unknown session bench mode: ${modeSetting}`)
  }
  const mode: Mode = modeSetting
  test.setTimeout((minutes + 10) * 60_000)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await electronApp.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.setBackgroundThrottling(false)
    }
  })
  await expect
    .poll(async () => orcaPage.locator('[data-radix-popper-content-wrapper]').count(), {
      timeout: 30_000
    })
    .toBe(0)
  await nativeTerminalDebug(electronApp, 'mainFeed', [true])
  await setNativeTerminalParseOnce(orcaPage, mode === 'native-parse-once')
  await enableNativeTerminal(orcaPage, mode !== 'xterm')
  const awayTab = await openTerminalTab(orcaPage)
  const sessionTab = await openTerminalTab(orcaPage)
  const ptyId = await waitForActivePanePtyId(orcaPage, 30_000)
  const surfaceId = await findNativeSurfaceForPane(
    orcaPage,
    ptyId,
    mode === 'xterm' ? 1_000 : 15_000
  )
  expect(surfaceId === null).toBe(mode === 'xterm')
  await (surfaceId === null
    ? waitForPtyShellEcho(orcaPage, ptyId, 30_000)
    : waitForNativeShellReady(orcaPage, electronApp, ptyId, surfaceId))

  const script = testInfo.outputPath('replay.cjs')
  const done = testInfo.outputPath('replay-done.json')
  writeReplayScript(script, done)
  const before = await usageSnapshot(electronApp)
  await sendToTerminal(orcaPage, ptyId, `${nodeTerminalCommand([script])}\r`)
  let triggers = 0
  while (!existsSync(done)) {
    await orcaPage.waitForTimeout(Math.min(triggerEveryMs, 5_000))
    if (existsSync(done) || Date.now() - before.at < (triggers + 1) * triggerEveryMs) {
      continue
    }
    triggers += 1
    await showDialogOverPane(orcaPage, ptyId)
    await orcaPage.waitForTimeout(DIALOG_MS)
    await removeDialog(orcaPage)
    await setActiveTab(orcaPage, awayTab)
    await orcaPage.waitForTimeout(AWAY_MS)
    await setActiveTab(orcaPage, sessionTab)
    if (surfaceId !== null) {
      await expect.poll(async () => isNativeSurfaceHidden(electronApp, surfaceId)).toBe(false)
      await expect.poll(async () => xtermScreenTransform(orcaPage, ptyId)).not.toBe('')
    }
  }
  const after = await usageSnapshot(electronApp)
  const seconds = (after.at - before.at) / 1000
  const rates = idleRatesBetween(before, after)
  const total = (kind: ProcessKind): KindTotal => ({
    instructions: rates[kind].instructionsPerS * seconds,
    cpuMs: rates[kind].cpuMsPerS * seconds,
    footprintMb: rates[kind].footprintMb
  })
  const totals = {
    main: total('main'),
    renderer: total('renderer'),
    gpu: total('gpu'),
    other: total('other')
  }
  const replay: unknown = JSON.parse(readFileSync(done, 'utf8'))
  const report = { mode, minutes, triggerEveryMs, triggers, seconds, replay, totals }
  const output =
    process.env.ORCA_NATIVE_TERMINAL_SESSION_OUTPUT ??
    testInfo.outputPath(`native-terminal-session-${mode}.json`)
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report, null, 2))
})
