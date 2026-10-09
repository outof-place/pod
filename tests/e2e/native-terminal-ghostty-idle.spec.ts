import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { writeFileSync } from 'node:fs'
import { test, expect } from './helpers/orca-app'
import { findNativeSurfaceForPane, isNativeSurfaceHidden } from './helpers/native-terminal-debug'
import { waitForActivePanePtyId, waitForActiveTerminalManager } from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForPtyShellEcho } from './terminal-pty-readiness'
import {
  addTerminalPane,
  measureIdleWindow,
  memoryReport,
  setTerminalMode,
  usageSnapshot,
  type IdleSample,
  type TerminalMode
} from './helpers/native-terminal-idle-usage'

// Idle cost of terminal panes: CPU time, instructions, timer wakeups and footprint per
// process, xterm.js vs native Ghostty, at 1/4/8 panes. Opt-in:
//   ORCA_NATIVE_TERMINAL_IDLE_BENCH=1 SKIP_BUILD=1 pnpm run test:e2e tests/e2e/native-terminal-ghostty-idle.spec.ts

const enabled = process.env.ORCA_NATIVE_TERMINAL_IDLE_BENCH === '1'
const rounds = Number(process.env.ORCA_NATIVE_TERMINAL_IDLE_ROUNDS ?? 3)
const idleMs = Number(process.env.ORCA_NATIVE_TERMINAL_IDLE_MS ?? 10_000)
const PANE_STEPS = [1, 4, 8]
const SETTLE_MS = 4_000

// Why: a hidden test window would otherwise be throttled like an occluded one, which a
// user's visible window never is.
test.use({
  orcaAppExtraArgs: [
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding'
  ],
  trace: 'off',
  screenshot: 'off'
})
test.skip(process.platform !== 'darwin', 'the native Ghostty terminal is macOS only')

// A fresh tab after the mode switch, so its first pane attaches in that mode.
async function openFirstPane(
  orcaPage: Page,
  electronApp: ElectronApplication,
  mode: TerminalMode
): Promise<void> {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  await electronApp.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.setBackgroundThrottling(false)
    }
  })
  // Why: a one-time sidebar hint popover overlaps the terminal and would hide native views.
  await expect
    .poll(async () => orcaPage.locator('[data-radix-popper-content-wrapper]').count(), {
      timeout: 30_000
    })
    .toBe(0)
  await setTerminalMode(orcaPage, mode)
  const firstTabId = await orcaPage.evaluate(() => window.__store?.getState().activeTabId)
  await orcaPage.evaluate(() => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    if (!state || !worktreeId) {
      throw new Error('no active worktree for an idle benchmark tab')
    }
    const tab = state.createTab(worktreeId, undefined, undefined, { activate: true })
    state.setActiveTab(tab.id)
    state.setActiveTabType('terminal', worktreeId)
  })
  await expect
    .poll(async () => orcaPage.evaluate(() => window.__store?.getState().activeTabId))
    .not.toBe(firstTabId)
  if (firstTabId) {
    await orcaPage.evaluate((id) => window.__store?.getState().closeTab(id), firstTabId)
  }
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const ptyId = await waitForActivePanePtyId(orcaPage, 30_000)
  await waitForPtyShellEcho(orcaPage, ptyId, 30_000)
  const surfaceId = await findNativeSurfaceForPane(
    orcaPage,
    ptyId,
    mode === 'native' ? 15_000 : 1_000
  )
  expect(surfaceId === null).toBe(mode === 'xterm')
  if (surfaceId !== null) {
    await expect.poll(async () => isNativeSurfaceHidden(electronApp, surfaceId)).toBe(false)
  }
}

for (const variant of ['xterm', 'native'] as const) {
  const mode: TerminalMode = variant === 'xterm' ? 'xterm' : 'native'
  test(`idle cost of ${variant} panes at ${PANE_STEPS.join('/')} panes`, async ({
    orcaPage,
    electronApp
  }, testInfo) => {
    test.skip(!enabled, 'Opt-in benchmark: set ORCA_NATIVE_TERMINAL_IDLE_BENCH=1')
    test.setTimeout(30 * 60_000)
    await openFirstPane(orcaPage, electronApp, mode)
    const samples: IdleSample[] = []
    const memory: Record<number, Record<string, ReturnType<typeof memoryReport>>> = {}
    let panes = 1
    for (const target of PANE_STEPS) {
      while (panes < target) {
        await addTerminalPane(orcaPage, electronApp, mode, panes)
        panes += 1
      }
      await orcaPage.waitForTimeout(SETTLE_MS)
      for (let round = 0; round < rounds; round += 1) {
        samples.push(await measureIdleWindow(electronApp, orcaPage, panes, idleMs))
      }
      const snapshot = await usageSnapshot(electronApp)
      memory[panes] = Object.fromEntries(
        snapshot.processes
          .filter((process) => process.kind !== 'other')
          .map((process) => [`${process.kind}-${process.pid}`, memoryReport(process.pid)])
      )
    }
    const output = testInfo.outputPath(`native-terminal-idle-${variant}.json`)
    writeFileSync(
      output,
      `${JSON.stringify({ mode: variant, rounds, idleMs, samples, memory }, null, 2)}\n`
    )
    await testInfo.attach(`native-terminal-idle-${variant}`, {
      path: output,
      contentType: 'application/json'
    })
    console.log(JSON.stringify({ mode: variant, samples }, null, 2))
  })
}
