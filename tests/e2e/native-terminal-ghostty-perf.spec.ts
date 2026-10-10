import type { ElectronApplication, Page, TestInfo } from '@stablyai/playwright-test'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { test, expect } from './helpers/orca-app'
import {
  enableNativeTerminal,
  findNativeSurfaceForPane,
  isNativeSurfaceHidden,
  nativeScreenText,
  nativeTerminalDebug,
  xtermScreenTransform
} from './helpers/native-terminal-debug'
import {
  cpuMsBetween,
  openTerminalTab,
  usageSnapshot,
  type CpuMsByKind,
  type UsageSnapshot
} from './helpers/native-terminal-process-usage'
import {
  removeDialog,
  setNativeTerminalParseOnce,
  showDialogOverPane,
  splitParseOncePane,
  waitForNativeShellReady
} from './helpers/native-terminal-parse-once'
import {
  focusActiveTerminalInput,
  sendToTerminal,
  splitActiveTerminalPane,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForPtyShellEcho } from './terminal-pty-readiness'
import { nodeTerminalCommand } from './terminal-node-command'
import {
  typingKeyMarkerPrefix,
  typingProbeReadyMarker,
  writeTypingEchoProbeScript
} from './sustained-agent-typing-load-scripts'
import { summarizeBenchmarkSamples } from '../../config/scripts/benchmark-sample-summary.mjs'

// Same workloads with experimentalNativeTerminal off (xterm.js WebGL), on (Ghostty/Metal fed by
// main), on with main's feed off (fed by the renderer mirror), and on with parse once (xterm off
// the byte stream under the view): an output flood, the native view hiding for a dialog right
// after it (xterm catching up first), keystroke-to-echo latency, and idle CPU and memory with
// eight panes. Opt-in, not a gate.
//   ORCA_NATIVE_TERMINAL_BENCH=1 SKIP_BUILD=1 pnpm run test:e2e tests/e2e/native-terminal-ghostty-perf.spec.ts

type Mode = 'xterm' | 'native' | 'native-mirror' | 'native-parse-once'

const enabled = process.env.ORCA_NATIVE_TERMINAL_BENCH === '1'
const rounds = Number(process.env.ORCA_NATIVE_TERMINAL_BENCH_ROUNDS ?? 5)
const floodLines = Number(process.env.ORCA_NATIVE_TERMINAL_BENCH_FLOOD_LINES ?? 300_000)
const keyCount = Number(process.env.ORCA_NATIVE_TERMINAL_BENCH_KEYS ?? 30)
const idleMs = Number(process.env.ORCA_NATIVE_TERMINAL_BENCH_IDLE_MS ?? 10_000)
const idlePanes = Number(process.env.ORCA_NATIVE_TERMINAL_BENCH_IDLE_PANES ?? 8)
// Why past 5 s: parse once suspends WebGL under a native view that long after the view shows.
const SETTLE_MS = 6_000
const KEY_GAP_MS = 40
const FLOOD_TIMEOUT_MS = 120_000
const KEY_TIMEOUT_MS = 2_000
// Main-side screen polling for the native path; coarse during floods so it barely costs CPU.
const FLOOD_POLL_MS = 5
const KEY_POLL_MS = 1
const MIRROR_WRITES_KEY = '__orcaE2eNativeMirrorWrites'

test.use({
  orcaAppExtraArgs: [
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding'
  ],
  trace: 'off',
  screenshot: 'off'
})
test.skip(process.platform !== 'darwin', 'the native Ghostty terminal is macOS only')
test.skip(!enabled, 'Opt-in benchmark: set ORCA_NATIVE_TERMINAL_BENCH=1')

type XtermWatch = {
  keyAt: number | null
  parsedAt: number | null
  paintedAt: number | null
  renders: number
  frames: number
}

type FloodSample = {
  wallMs: number
  cpuMs: CpuMsByKind
  xtermRenders: number
  frames: number
  // Renderer-to-main 'nativeTerminal:write' messages; PTY chunks main's feed took, and the
  // batched addon writes it made of them.
  mirrorWrites: number
  mainFeedChunks: number
  mainFeedWrites: number
}
type CatchUpSample = { wallMs: number; cpuMs: CpuMsByKind }
type KeySample = { keyToScreenMs: number; keyToParsedMs: number | null; keyToPtyMs: number | null }
type ModeSamples = {
  flood: FloodSample[]
  catchUp: CatchUpSample[]
  keys: KeySample[]
  idleCpuMsPerS: CpuMsByKind[]
  // Footprint per process kind with the idle panes open, in MiB.
  idleMemoryMiB: CpuMsByKind[]
  // Idle panes that still hold a WebGL context.
  idleWebglPanes: number[]
  webgl: boolean[]
  keyMirrorWrites: number[]
}

function now(): number {
  return performance.timeOrigin + performance.now()
}

// Counts renderer-to-main mirror writes; main's own feed sends none.
async function installMirrorWriteCounter(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }, key) => {
    const counter = { writes: 0 }
    Reflect.set(globalThis, key, counter)
    ipcMain.on('nativeTerminal:write', () => {
      counter.writes += 1
    })
  }, MIRROR_WRITES_KEY)
}

function mirrorWrites(app: ElectronApplication): Promise<number> {
  return app.evaluate(
    (_electron, key) => Number(Reflect.get(Object(Reflect.get(globalThis, key)), 'writes')),
    MIRROR_WRITES_KEY
  )
}

async function mainFeedStats(
  app: ElectronApplication
): Promise<{ chunks: number; writes: number }> {
  const stats: unknown = await nativeTerminalDebug(app, 'mainFeed')
  const read = (field: string): number =>
    typeof stats === 'object' && stats !== null ? Number(Reflect.get(stats, field)) : 0
  return { chunks: read('chunks'), writes: read('writes') }
}

function emptySamples(): ModeSamples {
  return {
    flood: [],
    catchUp: [],
    keys: [],
    idleCpuMsPerS: [],
    idleMemoryMiB: [],
    idleWebglPanes: [],
    webgl: [],
    keyMirrorWrites: []
  }
}

function footprintMiB(snapshot: UsageSnapshot): CpuMsByKind {
  const byKind: CpuMsByKind = { main: 0, renderer: 0, gpu: 0, total: 0 }
  for (const process of snapshot.processes) {
    const mib = process.usage.footprint / (1024 * 1024)
    byKind.total += mib
    if (process.kind !== 'other') {
      byKind[process.kind] += mib
    }
  }
  return byKind
}

function scaleCpu(cpu: CpuMsByKind, factor: number): CpuMsByKind {
  return {
    main: cpu.main * factor,
    renderer: cpu.renderer * factor,
    gpu: cpu.gpu * factor,
    total: cpu.total * factor
  }
}

// Arms a page-side watch on the pane's xterm for a line ending in `marker`: when xterm parsed
// it, when it next painted, and how many renders and animation frames ran meanwhile.
async function armXtermWatch(
  page: Page,
  ptyId: string,
  marker: string,
  waitForPaint: boolean,
  timeoutMs: number,
  watchStream = false
): Promise<string> {
  const key = `__orcaNativePerfWatch_${randomUUID()}`
  await page.evaluate(
    ({ id, watchKey, line, paint, timeout, stream }) => {
      // Parse once: xterm never sees the marker, so the run ends the watch once the renderer
      // has received it (its observers ran) and the native view shows it.
      let tail = ''
      let stopStream = (): void => {}
      const streamed = new Promise<void>((resolve) => {
        if (!stream) {
          resolve()
          return
        }
        stopStream = window.api.pty.onData((payload) => {
          if (payload.id !== id) {
            return
          }
          const text = tail + payload.data
          if (text.includes(line)) {
            stopStream()
            resolve()
          }
          tail = text.slice(-line.length)
        })
      })
      Reflect.set(window, `${watchKey}:streamed`, streamed)
      const pane = [...(window.__paneManagers?.values() ?? [])]
        .flatMap((manager) => manager.getPanes())
        .find((candidate) => candidate.container.dataset.ptyId === id)
      if (!pane) {
        throw new Error(`no pane for PTY ${id}`)
      }
      const terminal = pane.terminal
      const clock = (): number => performance.timeOrigin + performance.now()
      const result: {
        keyAt: number | null
        parsedAt: number | null
        paintedAt: number | null
        renders: number
        frames: number
      } = { keyAt: null, parsedAt: null, paintedAt: null, renders: 0, frames: 0 }
      const lineOnScreen = (): boolean => {
        const buffer = terminal.buffer.active
        const end = buffer.baseY + buffer.cursorY
        for (let y = end; y >= Math.max(0, end - 3); y -= 1) {
          if (buffer.getLine(y)?.translateToString(true).endsWith(line)) {
            return true
          }
        }
        return false
      }
      const done = new Promise((resolve) => {
        const cleanups: (() => void)[] = []
        const finish = (): void => {
          for (const cleanup of cleanups) {
            cleanup()
          }
          resolve(result)
        }
        Reflect.set(window, `${watchKey}:finish`, finish)
        cleanups.push(() => stopStream())
        let frame = requestAnimationFrame(function tick() {
          result.frames += 1
          frame = requestAnimationFrame(tick)
        })
        cleanups.push(() => cancelAnimationFrame(frame))
        const onKey = (event: KeyboardEvent): void => {
          result.keyAt ??= performance.timeOrigin + event.timeStamp
        }
        window.addEventListener('keydown', onKey, true)
        cleanups.push(() => window.removeEventListener('keydown', onKey, true))
        const parsed = terminal.onWriteParsed(() => {
          if (result.parsedAt === null && lineOnScreen()) {
            result.parsedAt = clock()
            if (!paint) {
              finish()
            }
          }
        })
        cleanups.push(() => parsed.dispose())
        const rendered = terminal.onRender(() => {
          result.renders += 1
          if (paint && result.parsedAt !== null && result.paintedAt === null) {
            result.paintedAt = clock()
            finish()
          }
        })
        cleanups.push(() => rendered.dispose())
        const timer = setTimeout(finish, timeout)
        cleanups.push(() => clearTimeout(timer))
      })
      Reflect.set(window, watchKey, done)
    },
    {
      id: ptyId,
      watchKey: key,
      line: marker,
      paint: waitForPaint,
      timeout: timeoutMs,
      stream: watchStream
    }
  )
  return key
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function finishXtermWatchOnceStreamed(page: Page, key: string): Promise<void> {
  return page.evaluate(async (watchKey) => {
    await Reflect.get(window, `${watchKey}:streamed`)
    const finish: unknown = Reflect.get(window, `${watchKey}:finish`)
    if (typeof finish === 'function') {
      finish()
    }
  }, key)
}

async function readXtermWatch(page: Page, key: string): Promise<XtermWatch> {
  const value: unknown = await page.evaluate((watchKey) => Reflect.get(window, watchKey), key)
  if (typeof value !== 'object' || value === null) {
    throw new Error('xterm watch returned nothing')
  }
  return {
    keyAt: numberOrNull(Reflect.get(value, 'keyAt')),
    parsedAt: numberOrNull(Reflect.get(value, 'parsedAt')),
    paintedAt: numberOrNull(Reflect.get(value, 'paintedAt')),
    renders: Number(Reflect.get(value, 'renders')),
    frames: Number(Reflect.get(value, 'frames'))
  }
}

// Polls the native surface's screen in main until a line ends with `marker`.
function watchNativeScreen(
  app: ElectronApplication,
  surfaceId: number,
  marker: string,
  pollMs: number,
  timeoutMs: number
): Promise<number | null> {
  return app.evaluate(
    async (_electron, { id, line, poll, timeout }) => {
      const debug: unknown = Reflect.get(globalThis, '__orcaNativeTerminalDebug')
      const screenText: unknown =
        typeof debug === 'object' && debug !== null ? Reflect.get(debug, 'screenText') : null
      if (typeof screenText !== 'function') {
        throw new Error('native terminal debug hooks are not installed')
      }
      const deadline = performance.now() + timeout
      while (performance.now() < deadline) {
        const text: unknown = Reflect.apply(screenText, debug, [id])
        if (
          typeof text === 'string' &&
          text.split('\n').some((row) => row.trimEnd().endsWith(line))
        ) {
          return performance.timeOrigin + performance.now()
        }
        await new Promise((resolve) => setTimeout(resolve, poll))
      }
      return null
    },
    { id: surfaceId, line: marker, poll: pollMs, timeout: timeoutMs }
  )
}

// One keystroke into the native view (the same keyDown path AppKit drives) timed until its
// echo is on the native screen, measured inside main so no test-runner round trip is counted.
function nativeKeystroke(
  app: ElectronApplication,
  surfaceId: number,
  character: string,
  marker: string
): Promise<{ keyAt: number; shownAt: number | null }> {
  return app.evaluate(
    async (_electron, { id, char, line, poll, timeout }) => {
      const debug: unknown = Reflect.get(globalThis, '__orcaNativeTerminalDebug')
      const key: unknown =
        typeof debug === 'object' && debug !== null ? Reflect.get(debug, 'key') : null
      const screenText: unknown =
        typeof debug === 'object' && debug !== null ? Reflect.get(debug, 'screenText') : null
      if (typeof key !== 'function' || typeof screenText !== 'function') {
        throw new Error('native terminal debug hooks are not installed')
      }
      const keyAt = performance.timeOrigin + performance.now()
      Reflect.apply(key, debug, [id, char, 0, 0])
      const deadline = performance.now() + timeout
      while (performance.now() < deadline) {
        const text: unknown = Reflect.apply(screenText, debug, [id])
        if (
          typeof text === 'string' &&
          text.split('\n').some((row) => row.trimEnd().endsWith(line))
        ) {
          return { keyAt, shownAt: performance.timeOrigin + performance.now() }
        }
        await new Promise((resolve) => setTimeout(resolve, poll))
      }
      return { keyAt, shownAt: null }
    },
    { id: surfaceId, char: character, line: marker, poll: KEY_POLL_MS, timeout: KEY_TIMEOUT_MS }
  )
}

function closeTab(page: Page, tabId: string): Promise<void> {
  return page.evaluate((id) => window.__store?.getState().closeTab(id), tabId)
}

function activePaneUsesWebgl(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const tabId = window.__store?.getState().activeTabId
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane()
    return pane ? manager?.hasWebglRenderer(pane.id) === true : false
  })
}

// A fresh pane in this mode; for native, the surface that shows it.
async function openBenchmarkPane(
  page: Page,
  app: ElectronApplication,
  mode: Mode
): Promise<{ tabId: string; ptyId: string; surfaceId: number | null }> {
  await nativeTerminalDebug(app, 'mainFeed', [mode !== 'native-mirror'])
  await setNativeTerminalParseOnce(page, mode === 'native-parse-once')
  await enableNativeTerminal(page, mode !== 'xterm')
  const tabId = await openTerminalTab(page)
  const ptyId = await waitForActivePanePtyId(page, 30_000)
  const surfaceId = await findNativeSurfaceForPane(page, ptyId, mode === 'xterm' ? 1_000 : 15_000)
  // Parse once keeps the shell's output out of xterm, so readiness reads the native screen.
  await (mode === 'native-parse-once' && surfaceId !== null
    ? waitForNativeShellReady(page, app, ptyId, surfaceId)
    : waitForPtyShellEcho(page, ptyId, 30_000))
  // The xterm baseline must not have a native view; the native run must have one, on screen.
  expect(surfaceId === null).toBe(mode === 'xterm')
  if (surfaceId !== null) {
    await expect.poll(async () => isNativeSurfaceHidden(app, surfaceId)).toBe(false)
    // Steady state: xterm has stopped painting under the native view.
    await expect.poll(async () => xtermScreenTransform(page, ptyId)).not.toBe('')
  }
  return { tabId, ptyId, surfaceId }
}

async function measureFlood(
  page: Page,
  app: ElectronApplication,
  ptyId: string,
  surfaceId: number | null,
  parseOnce: boolean
): Promise<FloodSample> {
  const id = randomUUID()
  const marker = `FLOOD-${id}`
  const watch = await armXtermWatch(
    page,
    ptyId,
    marker,
    surfaceId === null,
    FLOOD_TIMEOUT_MS,
    parseOnce
  )
  const writesBefore = await mirrorWrites(app)
  const feedBefore = await mainFeedStats(app)
  const before = await usageSnapshot(app)
  const startedAt = now()
  const native =
    surfaceId === null
      ? null
      : watchNativeScreen(app, surfaceId, marker, FLOOD_POLL_MS, FLOOD_TIMEOUT_MS)
  await sendToTerminal(page, ptyId, `seq 1 ${floodLines}; printf 'FLOOD-%s\\n' ${id}\r`)
  if (parseOnce && native) {
    await native
    await finishXtermWatchOnceStreamed(page, watch)
  }
  const xterm = await readXtermWatch(page, watch)
  const shownAt = native ? await native : xterm.paintedAt
  const after = await usageSnapshot(app)
  if (shownAt === null) {
    throw new Error(`flood did not reach the ${surfaceId === null ? 'xterm' : 'native'} screen`)
  }
  const feedAfter = await mainFeedStats(app)
  return {
    wallMs: shownAt - startedAt,
    cpuMs: cpuMsBetween(before, after),
    xtermRenders: xterm.renders,
    frames: xterm.frames,
    mirrorWrites: (await mirrorWrites(app)) - writesBefore,
    mainFeedChunks: feedAfter.chunks - feedBefore.chunks,
    mainFeedWrites: feedAfter.writes - feedBefore.writes
  }
}

// Main-side wait for the native view to hide; under parse once it hides only after xterm caught up.
function watchNativeHidden(
  app: ElectronApplication,
  surfaceId: number,
  timeoutMs: number
): Promise<number | null> {
  return app.evaluate(
    async (_electron, { id, poll, timeout }) => {
      const debug: unknown = Reflect.get(globalThis, '__orcaNativeTerminalDebug')
      const state: unknown =
        typeof debug === 'object' && debug !== null ? Reflect.get(debug, 'state') : null
      if (typeof state !== 'function') {
        throw new Error('native terminal debug hooks are not installed')
      }
      const deadline = performance.now() + timeout
      while (performance.now() < deadline) {
        const value: unknown = Reflect.apply(state, debug, [id])
        if (typeof value === 'object' && value !== null && Reflect.get(value, 'hidden') === true) {
          return performance.timeOrigin + performance.now()
        }
        await new Promise((resolve) => setTimeout(resolve, poll))
      }
      return null
    },
    { id: surfaceId, poll: KEY_POLL_MS, timeout: timeoutMs }
  )
}

// A dialog over the pane right after the flood: the time and CPU until the native view hid.
async function measureCatchUp(
  page: Page,
  app: ElectronApplication,
  ptyId: string,
  surfaceId: number
): Promise<CatchUpSample> {
  const before = await usageSnapshot(app)
  const startedAt = now()
  const hidden = watchNativeHidden(app, surfaceId, FLOOD_TIMEOUT_MS)
  await showDialogOverPane(page, ptyId)
  const hiddenAt = await hidden
  const after = await usageSnapshot(app)
  await removeDialog(page)
  if (hiddenAt === null) {
    throw new Error('the native view never hid for the dialog')
  }
  await expect.poll(async () => isNativeSurfaceHidden(app, surfaceId)).toBe(false)
  await expect.poll(async () => xtermScreenTransform(page, ptyId)).not.toBe('')
  return { wallMs: hiddenAt - startedAt, cpuMs: cpuMsBetween(before, after) }
}

async function measureKeystrokes(
  page: Page,
  app: ElectronApplication,
  ptyId: string,
  surfaceId: number | null,
  testInfo: TestInfo
): Promise<{ keys: KeySample[]; mirrorWrites: number }> {
  const runId = randomUUID().slice(0, 8)
  const scriptPath = testInfo.outputPath(`echo-${runId}.mjs`)
  const arrivalsPath = testInfo.outputPath(`arrivals-${runId}.jsonl`)
  writeTypingEchoProbeScript(scriptPath, runId, arrivalsPath)
  await sendToTerminal(page, ptyId, `${nodeTerminalCommand([scriptPath])}\r`)
  await (surfaceId === null
    ? waitForTerminalOutput(page, typingProbeReadyMarker(runId), 15_000)
    : expect
        .poll(async () => nativeScreenText(app, surfaceId), { timeout: 15_000 })
        .toContain(typingProbeReadyMarker(runId)))
  if (surfaceId === null) {
    await focusActiveTerminalInput(page)
  }
  const timings: { keyAt: number; parsedAt: number | null; shownAt: number }[] = []
  const writesBefore = await mirrorWrites(app)
  for (let seq = 1; seq <= keyCount; seq += 1) {
    const character = String.fromCharCode(97 + ((seq - 1) % 26))
    const marker = `${typingKeyMarkerPrefix(runId)}${seq}`
    if (surfaceId === null) {
      const watch = await armXtermWatch(page, ptyId, marker, true, KEY_TIMEOUT_MS)
      await page.keyboard.type(character)
      const result = await readXtermWatch(page, watch)
      if (result.keyAt === null || result.paintedAt === null) {
        throw new Error(`xterm key ${seq} never echoed`)
      }
      timings.push({ keyAt: result.keyAt, parsedAt: result.parsedAt, shownAt: result.paintedAt })
    } else {
      const result = await nativeKeystroke(app, surfaceId, character, marker)
      if (result.shownAt === null) {
        throw new Error(`native key ${seq} never echoed`)
      }
      timings.push({ keyAt: result.keyAt, parsedAt: null, shownAt: result.shownAt })
    }
    await page.waitForTimeout(KEY_GAP_MS)
  }
  const keyWrites = (await mirrorWrites(app)) - writesBefore
  await sendToTerminal(page, ptyId, '\x03')
  const arrivals = new Map<number, number>()
  if (existsSync(arrivalsPath)) {
    for (const row of readFileSync(arrivalsPath, 'utf8').split('\n')) {
      if (row.trim().length === 0) {
        continue
      }
      const parsed: unknown = JSON.parse(row)
      const seq = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'seq') : null
      const atMs =
        typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'atMs') : null
      if (typeof seq === 'number' && typeof atMs === 'number') {
        arrivals.set(seq, atMs)
      }
    }
  }
  const keys = timings.map((timing, index) => {
    const arrivedAt = arrivals.get(index + 1)
    return {
      keyToScreenMs: timing.shownAt - timing.keyAt,
      keyToParsedMs: timing.parsedAt === null ? null : timing.parsedAt - timing.keyAt,
      keyToPtyMs: arrivedAt === undefined ? null : arrivedAt - timing.keyAt
    }
  })
  return { keys, mirrorWrites: keyWrites }
}

async function activatePaneForPty(page: Page, ptyId: string): Promise<void> {
  await page.evaluate((id) => {
    for (const manager of window.__paneManagers?.values() ?? []) {
      const pane = manager.getPanes().find((candidate) => candidate.container.dataset.ptyId === id)
      if (pane) {
        manager.setActivePane(pane.id, { focus: false })
        return
      }
    }
  }, ptyId)
  await expect.poll(async () => waitForActivePanePtyId(page)).toBe(ptyId)
}

// Splits the active pane; resolves with the new pane's PTY once its shell runs (and, for the
// native modes, once its native view is on screen).
async function splitBenchmarkPane(
  page: Page,
  app: ElectronApplication,
  mode: Mode,
  direction: 'vertical' | 'horizontal'
): Promise<string> {
  if (mode === 'native-parse-once') {
    return (await splitParseOncePane(page, app, direction)).ptyId
  }
  const previous = await waitForActivePanePtyId(page)
  await splitActiveTerminalPane(page, direction)
  await expect.poll(async () => waitForActivePanePtyId(page)).not.toBe(previous)
  const ptyId = await waitForActivePanePtyId(page)
  await waitForPtyShellEcho(page, ptyId, 30_000)
  if (mode !== 'xterm') {
    const surfaceId = await findNativeSurfaceForPane(page, ptyId)
    if (surfaceId === null) {
      throw new Error(`no native terminal surface shows the new pane ${ptyId}`)
    }
    await expect.poll(async () => isNativeSurfaceHidden(app, surfaceId)).toBe(false)
  }
  return ptyId
}

function activeTabWebglPanes(page: Page): Promise<number> {
  return page.evaluate(() => {
    const tabId = window.__store?.getState().activeTabId
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    return (manager?.getPanes() ?? []).filter((pane) => manager?.hasWebglRenderer(pane.id)).length
  })
}

async function measureIdle(
  page: Page,
  app: ElectronApplication,
  mode: Mode
): Promise<{ cpu: CpuMsByKind; memory: CpuMsByKind; webglPanes: number }> {
  // A balanced grid: every pane splits once per level, the direction alternating by level.
  const ptyIds = [await waitForActivePanePtyId(page)]
  for (let level = 0; ptyIds.length < idlePanes; level += 1) {
    // Why a copy: the split appends to the list this level walks.
    for (const target of ptyIds.slice()) {
      if (ptyIds.length >= idlePanes) {
        break
      }
      await activatePaneForPty(page, target)
      ptyIds.push(
        await splitBenchmarkPane(page, app, mode, level % 2 === 0 ? 'vertical' : 'horizontal')
      )
    }
  }
  await page.waitForTimeout(SETTLE_MS)
  const before = await usageSnapshot(app)
  await page.waitForTimeout(idleMs)
  const after = await usageSnapshot(app)
  return {
    cpu: scaleCpu(cpuMsBetween(before, after), 1000 / (after.at - before.at)),
    memory: footprintMiB(after),
    webglPanes: await activeTabWebglPanes(page)
  }
}

function summarize(values: number[]): ReturnType<typeof summarizeBenchmarkSamples> | null {
  return values.length > 0 ? summarizeBenchmarkSamples(values) : null
}

function summarizeCpu(
  samples: CpuMsByKind[]
): Record<keyof CpuMsByKind, ReturnType<typeof summarize>> {
  return {
    main: summarize(samples.map((sample) => sample.main)),
    renderer: summarize(samples.map((sample) => sample.renderer)),
    gpu: summarize(samples.map((sample) => sample.gpu)),
    total: summarize(samples.map((sample) => sample.total))
  }
}

function summarizeMode(samples: ModeSamples): Record<string, unknown> {
  return {
    webglPanes: samples.webgl,
    floodWallMs: summarize(samples.flood.map((sample) => sample.wallMs)),
    floodCpuMs: summarizeCpu(samples.flood.map((sample) => sample.cpuMs)),
    floodXtermRenders: samples.flood.map((sample) => sample.xtermRenders),
    floodAnimationFrames: samples.flood.map((sample) => sample.frames),
    floodMirrorWrites: samples.flood.map((sample) => sample.mirrorWrites),
    floodMainFeedChunks: samples.flood.map((sample) => sample.mainFeedChunks),
    floodMainFeedWrites: samples.flood.map((sample) => sample.mainFeedWrites),
    catchUpMs: summarize(samples.catchUp.map((sample) => sample.wallMs)),
    catchUpCpuMs: summarizeCpu(samples.catchUp.map((sample) => sample.cpuMs)),
    keyMirrorWrites: samples.keyMirrorWrites,
    keyToScreenMs: summarize(samples.keys.map((sample) => sample.keyToScreenMs)),
    keyToXtermParsedMs: summarize(
      samples.keys.flatMap((sample) =>
        sample.keyToParsedMs === null ? [] : [sample.keyToParsedMs]
      )
    ),
    keyToPtyMs: summarize(
      samples.keys.flatMap((sample) => (sample.keyToPtyMs === null ? [] : [sample.keyToPtyMs]))
    ),
    idleCpuMsPerS: summarizeCpu(samples.idleCpuMsPerS),
    idleMemoryMiB: summarizeCpu(samples.idleMemoryMiB),
    idleWebglPanes: samples.idleWebglPanes
  }
}

test('native terminal vs xterm.js: output flood, keystroke echo, idle CPU', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  test.setTimeout(60 * 60_000)
  for (const [name, value, minimum] of [
    ['rounds', rounds, 1],
    ['flood lines', floodLines, 1],
    ['keys', keyCount, 1],
    ['idle ms', idleMs, 1000],
    ['idle panes', idlePanes, 1]
  ] as const) {
    if (!Number.isInteger(value) || value < minimum) {
      throw new Error(`Invalid native terminal benchmark ${name}: ${value}`)
    }
  }
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  // Why: the hidden test window would otherwise throttle rAF, and xterm would never paint.
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
  await installMirrorWriteCounter(electronApp)

  const modes: Mode[] = ['xterm', 'native', 'native-mirror', 'native-parse-once']
  const samples: Record<Mode, ModeSamples> = {
    xterm: emptySamples(),
    native: emptySamples(),
    'native-mirror': emptySamples(),
    'native-parse-once': emptySamples()
  }
  for (let round = 0; round < rounds; round += 1) {
    // Rotate the order so warm-up and thermal drift do not favor one mode.
    for (const mode of modes.map((_, index) => modes[(index + round) % modes.length])) {
      const { tabId, ptyId, surfaceId } = await openBenchmarkPane(orcaPage, electronApp, mode)
      samples[mode].webgl.push(await activePaneUsesWebgl(orcaPage))
      samples[mode].flood.push(
        await measureFlood(orcaPage, electronApp, ptyId, surfaceId, mode === 'native-parse-once')
      )
      if (surfaceId !== null) {
        samples[mode].catchUp.push(await measureCatchUp(orcaPage, electronApp, ptyId, surfaceId))
      }
      const typed = await measureKeystrokes(orcaPage, electronApp, ptyId, surfaceId, testInfo)
      samples[mode].keys.push(...typed.keys)
      samples[mode].keyMirrorWrites.push(typed.mirrorWrites)
      const idle = await measureIdle(orcaPage, electronApp, mode)
      samples[mode].idleCpuMsPerS.push(idle.cpu)
      samples[mode].idleMemoryMiB.push(idle.memory)
      samples[mode].idleWebglPanes.push(idle.webglPanes)
      await closeTab(orcaPage, tabId)
      await orcaPage.waitForTimeout(1_000)
    }
  }
  await nativeTerminalDebug(electronApp, 'mainFeed', [true])
  await setNativeTerminalParseOnce(orcaPage, false)

  const summaries = {
    xterm: summarizeMode(samples.xterm),
    native: summarizeMode(samples.native),
    'native-mirror': summarizeMode(samples['native-mirror']),
    'native-parse-once': summarizeMode(samples['native-parse-once'])
  }
  const report = {
    config: { rounds, floodLines, keyCount, idleMs, idlePanes },
    ...summaries,
    samples
  }
  const output =
    process.env.ORCA_NATIVE_TERMINAL_BENCH_OUTPUT ??
    testInfo.outputPath('native-terminal-perf.json')
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
  await testInfo.attach('native-terminal-perf', { path: output, contentType: 'application/json' })
  console.log(JSON.stringify(summaries, null, 2))
})
