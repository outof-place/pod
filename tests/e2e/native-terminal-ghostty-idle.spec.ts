import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { writeFileSync } from 'node:fs'
import { test, expect } from './helpers/orca-app'
import {
  findNativeSurfaceForPane,
  isNativeSurfaceHidden,
  nativeScreenText,
  nativeSurfaceField,
  nativeSurfaceIds,
  nativeTerminalDebug
} from './helpers/native-terminal-debug'
import {
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
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
const GATE_PANES = 4
const GATE_IDLE_MS = 5_000
const GATE_MAIN_MB_PER_PANE = 30
const GATE_MAIN_WAKEUPS_PER_PANE = 5

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

// The active pane's surface takes the keyboard of a window treated as key in an active app.
async function focusActiveNativeSurface(page: Page, app: ElectronApplication): Promise<void> {
  const surfaceId = await findNativeSurfaceForPane(page, await waitForActivePanePtyId(page))
  if (surfaceId === null) {
    throw new Error('the active pane has no native surface')
  }
  await nativeTerminalDebug(app, 'secureInput', [surfaceId, true])
  await nativeTerminalDebug(app, 'focus', [surfaceId])
  await expect.poll(async () => nativeSurfaceField(app, surfaceId, 'ghosttyFocused')).toBe(true)
}

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

// Why native-focused: a hidden test app is never active, so no surface holds the keyboard of
// a key window; this variant simulates that for the active pane, as on a user's screen.
for (const variant of ['xterm', 'native', 'native-focused'] as const) {
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
      if (variant === 'native-focused') {
        await focusActiveNativeSurface(orcaPage, electronApp)
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

// Native panes left alone must cost nothing per frame: no frame reports, no app ticks, and no
// Ghostty redraws except the keyboard owner's cursor timer, whose window must be key.
test('idle native panes stay quiet and release what they do not draw', async ({
  orcaPage,
  electronApp
}) => {
  test.setTimeout(5 * 60_000)
  const xtermOnly = await usageSnapshot(electronApp)
  await openFirstPane(orcaPage, electronApp, 'native')
  for (let panes = 1; panes < GATE_PANES; panes += 1) {
    await addTerminalPane(orcaPage, electronApp, 'native', panes)
  }
  const surfaceIds = await nativeSurfaceIds(electronApp)
  expect(surfaceIds).toHaveLength(GATE_PANES)
  // A hidden test app is never active, so no surface is Ghostty-focused.
  for (const surfaceId of surfaceIds) {
    expect(await nativeSurfaceField(electronApp, surfaceId, 'ghosttyFocused')).toBe(false)
  }
  await orcaPage.waitForTimeout(SETTLE_MS)

  const idle = await measureIdleWindow(electronApp, orcaPage, GATE_PANES, GATE_IDLE_MS)
  expect(idle.counters).toEqual({ ticksPerS: 0, setFramesPerS: 0, presentedFramesPerS: 0 })
  // Why per pane over the xterm-only start: Metal's ~225 MB working pool stays resident while
  // anything redraws within ~1 s, and every pane's swap chain and atlases come on top.
  const mainBefore = xtermOnly.processes.find((process) => process.kind === 'main')
  const mainNow = (await usageSnapshot(electronApp)).processes.find(
    (process) => process.kind === 'main'
  )
  expect(mainBefore && mainNow).toBeTruthy()
  const growthMbPerPane =
    ((mainNow?.usage.footprint ?? 0) - (mainBefore?.usage.footprint ?? 0)) /
    (1024 * 1024) /
    GATE_PANES
  expect(growthMbPerPane).toBeLessThan(GATE_MAIN_MB_PER_PANE)
  expect(idle.byKind.main.wakeupsPerS / GATE_PANES).toBeLessThan(GATE_MAIN_WAKEUPS_PER_PANE)

  // The keyboard owner of a key window blinks (redraws) on Ghostty's cursor timer; no other does.
  const owner = surfaceIds.at(-1) ?? 0
  await nativeTerminalDebug(electronApp, 'secureInput', [owner, true])
  await nativeTerminalDebug(electronApp, 'focus', [owner])
  await expect.poll(async () => nativeSurfaceField(electronApp, owner, 'ghosttyFocused')).toBe(true)
  const framesBefore = await presentedFramesBySurface(electronApp, surfaceIds)
  await orcaPage.waitForTimeout(3_000)
  const framesAfter = await presentedFramesBySurface(electronApp, surfaceIds)
  for (const surfaceId of surfaceIds) {
    const drawn = (framesAfter.get(surfaceId) ?? 0) - (framesBefore.get(surfaceId) ?? 0)
    expect(drawn, `surface ${surfaceId} frames`).toBeLessThanOrEqual(surfaceId === owner ? 8 : 0)
  }
  // Why one evaluate: AppKit still names a resigning view first responder, and no timer may
  // run in between to paper over a surface left focused.
  const focusedAfterRelease = await electronApp.evaluate((_electron, id) => {
    const debug: unknown = Reflect.get(globalThis, '__orcaNativeTerminalDebug')
    if (typeof debug !== 'object' || debug === null) {
      throw new Error('native terminal debug hooks are not installed')
    }
    Reflect.apply(Reflect.get(debug, 'releaseKeyboard'), debug, [[id]])
    const state: unknown = Reflect.apply(Reflect.get(debug, 'state'), debug, [id])
    return typeof state === 'object' && state !== null ? Reflect.get(state, 'ghosttyFocused') : null
  }, owner)
  expect(focusedAfterRelease).toBe(false)
  await nativeTerminalDebug(electronApp, 'secureInput', [owner, false])

  // An occluded window draws nothing, then catches up once it is on screen again.
  const ptyId = await waitForActivePanePtyId(orcaPage)
  const surfaceId = await findNativeSurfaceForPane(orcaPage, ptyId)
  expect(surfaceId).not.toBeNull()
  const id = surfaceId ?? 0
  await nativeTerminalDebug(electronApp, 'windowOcclusion', [false])
  await expect.poll(async () => nativeSurfaceField(electronApp, id, 'ghosttyVisible')).toBe(false)
  const occludedFrames = Number(await nativeSurfaceField(electronApp, id, 'presentedFrames'))
  await sendToTerminal(orcaPage, ptyId, 'echo ORCA_OCCLUDED_$((6*7))\r')
  await waitForTerminalOutput(orcaPage, 'ORCA_OCCLUDED_42')
  await orcaPage.waitForTimeout(500)
  expect(Number(await nativeSurfaceField(electronApp, id, 'presentedFrames'))).toBe(occludedFrames)
  await nativeTerminalDebug(electronApp, 'windowOcclusion', [null])
  await expect.poll(async () => nativeSurfaceField(electronApp, id, 'ghosttyVisible')).toBe(true)
  await expect
    .poll(async () => Number(await nativeSurfaceField(electronApp, id, 'presentedFrames')))
    .toBeGreaterThan(occludedFrames)
  await expect.poll(async () => nativeScreenText(electronApp, id)).toContain('ORCA_OCCLUDED_42')
})

async function presentedFramesBySurface(
  app: ElectronApplication,
  surfaceIds: number[]
): Promise<Map<number, number>> {
  const frames = new Map<number, number>()
  for (const surfaceId of surfaceIds) {
    frames.set(surfaceId, Number(await nativeSurfaceField(app, surfaceId, 'presentedFrames')))
  }
  return frames
}

// With no polling, a pane moved by a transition (no resize, no mutation mid-flight) must still
// end up under its native view.
test('a native view follows its pane through a transition that only moves it', async ({
  orcaPage,
  electronApp
}) => {
  await openFirstPane(orcaPage, electronApp, 'native')
  const ptyId = await waitForActivePanePtyId(orcaPage)
  const surfaceId = (await findNativeSurfaceForPane(orcaPage, ptyId)) ?? 0
  await orcaPage.waitForTimeout(1_000)
  const startX = Number(await nativeSurfaceField(electronApp, surfaceId, 'x'))
  const shift = await orcaPage.evaluate(async (id) => {
    const pane = document.querySelector<HTMLElement>(`.pane[data-pty-id="${id}"]`)
    if (!pane) {
      throw new Error(`no pane for PTY ${id}`)
    }
    const before = pane.getBoundingClientRect().left
    const ended = new Promise((resolve) =>
      pane.addEventListener('transitionend', resolve, { once: true })
    )
    pane.style.transition = 'transform 400ms linear'
    pane.style.transform = 'translateX(48px)'
    await ended
    return pane.getBoundingClientRect().left - before
  }, ptyId)
  expect(shift).toBeGreaterThan(40)
  await expect
    .poll(async () =>
      Math.abs(Number(await nativeSurfaceField(electronApp, surfaceId, 'x')) - startX - shift)
    )
    .toBeLessThanOrEqual(1)
})
