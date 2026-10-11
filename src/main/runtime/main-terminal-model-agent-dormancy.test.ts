import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TuiAgent } from '../../shared/tui-agent'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'
import { FakeDaemonModel } from './fake-daemon-terminal-model.test-fixture'
import { MAIN_TERMINAL_MODEL_DORMANT_AFTER_MS } from './main-terminal-model-dormancy'
import { readRuntimeFixture } from './agent-transcript-replay-test-harness'
import { getHiddenRendererPtyDeliveryDebug } from '../ipc/pty-hidden-delivery-gate'

const SIZE = { cols: 80, rows: 24 }
const CODEX_SIZE = { cols: 120, rows: 40 }
// Why a neutral line: a ready screen would make the title's ready strong.
const NAME_ONLY_TITLE_OUTPUT = '\x1b]0;Codex\x07Reading the repository layout\r\n'

/** An agent pane on a local daemon whose output went quiet long enough for main's model to rest. */
async function createQuietAgentPane(
  agent: TuiAgent,
  output: string,
  size = SIZE,
  /** Delays the daemon snapshot; 'never' leaves it unanswered, so the seed times out;
   *  'fails-once' leaves only the first one unanswered, so a retried seed lands. */
  snapshotDelayMs: number | 'never' | 'fails-once' = 0
) {
  const daemon = new FakeDaemonModel(size)
  let snapshots = 0
  const pane = await createTranscriptPane({
    paneTitle: 'Terminal',
    foregroundProcess: null,
    launchAgent: agent,
    size,
    data: '',
    settledDaemonSnapshot: () =>
      snapshotDelayMs === 'never' || (snapshotDelayMs === 'fails-once' && snapshots++ === 0)
        ? new Promise<never>(() => {})
        : snapshotDelayMs === 'fails-once'
          ? daemon.snapshot()
          : snapshotDelayMs > 0
            ? new Promise((resolve) =>
                setTimeout(() => resolve(daemon.snapshot()), snapshotDelayMs)
              )
            : daemon.snapshot()
  })
  // Why only Date: emulator writes settle on real timers; the quiet period is measured by Date.now.
  vi.useFakeTimers({ toFake: ['Date'] })
  const emit = async (data: string): Promise<void> => {
    await daemon.feed(data)
    pane.runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, data, Date.now())
  }
  await emit(output)
  // Why a read: it drains main's write chain, and main may rest only once every byte is applied.
  await pane.runtime.readTerminal(pane.handle, { screen: true })
  vi.setSystemTime(Date.now() + MAIN_TERMINAL_MODEL_DORMANT_AFTER_MS)
  // Why a no-op chunk: main lets its model go at the first chunk after the quiet period.
  await emit('\x1b[?25l')
  // Under fake timers: the daemon counts the bytes at once, its parse finishes as timers advance.
  const emitNow = (data: string): void => {
    void daemon.feed(data)
    pane.runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, data, Date.now())
  }
  return { ...pane, emitNow }
}

/** A tui-idle wait from the current (fake) time, with the poll's timers driven. */
async function waitForIdleFromNow(
  pane: Awaited<ReturnType<typeof createQuietAgentPane>>,
  timeoutMs: number
) {
  vi.useFakeTimers({
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    now: Date.now()
  })
  const waiting = pane.runtime.waitForTerminal(pane.handle, { condition: 'tui-idle', timeoutMs })
  void waiting.catch(() => {})
  await vi.advanceTimersByTimeAsync(timeoutMs)
  return await waiting
}

describe("main's terminal model for an agent pane", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each<TuiAgent>([
    'claude',
    'gemini',
    'opencode',
    'codex',
    'cline',
    'antigravity',
    'qoder',
    'omp'
  ])('rests for %s', async (agent) => {
    const { runtime } = await createQuietAgentPane(agent, 'ready\r\n')
    expect(runtime.isMainTerminalModelDormant(TRANSCRIPT_PANE_PTY_ID)).toBe(true)
  })

  it("stays live for freebuff, whose status is read from main's screen on every chunk", async () => {
    const { runtime } = await createQuietAgentPane('freebuff', 'ready\r\n')
    expect(runtime.isMainTerminalModelDormant(TRANSCRIPT_PANE_PTY_ID)).toBe(false)
  })

  it('settles a wait on a dormant Codex pane from its rebuilt screen', async () => {
    const pane = await createQuietAgentPane(
      'codex',
      readRuntimeFixture('codex-0157-plain-ready'),
      CODEX_SIZE
    )
    expect(pane.runtime.isMainTerminalModelDormant(TRANSCRIPT_PANE_PTY_ID)).toBe(true)
    await expect(waitForIdleFromNow(pane, 8_000)).resolves.toMatchObject({
      condition: 'tui-idle',
      satisfied: true
    })
  }, 15_000)

  it('settles a weak-ready wait as the rebuild lands, not on the next poll', async () => {
    // Why the name-only title: its ready is weak, which only a poll's screen read settles.
    const pane = await createQuietAgentPane('codex', NAME_ONLY_TITLE_OUTPUT, CODEX_SIZE, 500)
    expect(pane.runtime.isMainTerminalModelDormant(TRANSCRIPT_PANE_PTY_ID)).toBe(true)
    // Why quiet first: a name-only title counts only on a quiet stream, which a live model settles at once.
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
      now: Date.now() + MAIN_TERMINAL_MODEL_DORMANT_AFTER_MS
    })
    const startedAt = Date.now()
    let settledAt = -1
    const waiting = pane.runtime
      .waitForTerminal(pane.handle, { condition: 'tui-idle', timeoutMs: 6_000 })
      .then((result) => {
        settledAt = Date.now()
        return result
      })
    void waiting.catch(() => {})
    await vi.advanceTimersByTimeAsync(6_000)
    await expect(waiting).resolves.toMatchObject({ condition: 'tui-idle', satisfied: true })
    // The poll sweeps every 2 s; the rebuild lands at 0.5 s.
    expect(settledAt - startedAt).toBeLessThan(1_000)
  }, 15_000)

  it.each([
    ['lands', 1_000],
    ['times out', 5_000]
  ])(
    'does not settle a provisional Codex screen from its text while a slow rebuild %s',
    async (_label, snapshotDelayMs) => {
      const data = readRuntimeFixture('codex-0157-fresh-home-daemon-install')
      const install = data.indexOf('Installing daemon')
      // Presence precondition: the cut's text alone reads as ready (see codex-header-readiness).
      expect(install).toBeGreaterThan(0)
      const pane = await createQuietAgentPane(
        'codex',
        data.slice(0, data.indexOf('\n', install) + 1),
        CODEX_SIZE,
        snapshotDelayMs
      )
      expect(pane.runtime.isMainTerminalModelDormant(TRANSCRIPT_PANE_PTY_ID)).toBe(true)
      await expect(waitForIdleFromNow(pane, 6_000)).rejects.toThrow(/timeout/)
    },
    15_000
  )

  it('does not settle a busy Antigravity pane from its text while a slow rebuild lands', async () => {
    // Why this recording: its last frame's text reads as ready, and only the screen says busy.
    const pane = await createQuietAgentPane(
      'antigravity',
      readRuntimeFixture('antigravity-1-2-14-busy-streaming'),
      CODEX_SIZE,
      1_000
    )
    expect(pane.runtime.isMainTerminalModelDormant(TRANSCRIPT_PANE_PTY_ID)).toBe(true)
    await expect(waitForIdleFromNow(pane, 6_000)).rejects.toThrow(/timeout/)
  }, 15_000)

  it('does not report a busy Antigravity pane idle while its rebuild keeps failing', async () => {
    // Why: a failed seed leaves a partial model, so the busy screen must still veto the text.
    const pane = await createQuietAgentPane(
      'antigravity',
      readRuntimeFixture('antigravity-1-2-14-busy-streaming'),
      CODEX_SIZE,
      'never'
    )
    expect(pane.runtime.isMainTerminalModelDormant(TRANSCRIPT_PANE_PTY_ID)).toBe(true)
    await expect(waitForIdleFromNow(pane, 6_000)).rejects.toThrow(/timeout/)
  }, 15_000)

  it.each([
    ['a ready screen', () => readRuntimeFixture('codex-0157-plain-ready')],
    ['a name-only title', () => NAME_ONLY_TITLE_OUTPUT]
  ])(
    'holds a wait on %s while the rebuild keeps failing, and retries it',
    async (_l, output) => {
      const pane = await createQuietAgentPane('codex', output(), CODEX_SIZE, 'never')
      const failuresBefore = getHiddenRendererPtyDeliveryDebug().mainTerminalModelSeedFailureCount
      await expect(waitForIdleFromNow(pane, 10_000)).rejects.toThrow(/timeout/)
      // Each poll after the backoff retries the seed: 2 s timeout, then 1 s, 2 s, 4 s apart.
      expect(
        getHiddenRendererPtyDeliveryDebug().mainTerminalModelSeedFailureCount - failuresBefore
      ).toBeGreaterThanOrEqual(2)
    },
    20_000
  )

  it.each([
    ['a ready screen', () => readRuntimeFixture('codex-0157-plain-ready')],
    ['a name-only title', () => NAME_ONLY_TITLE_OUTPUT]
  ])(
    'settles a wait on %s once a retried rebuild lands',
    async (_label, output) => {
      const pane = await createQuietAgentPane('codex', output(), CODEX_SIZE, 'fails-once')
      expect(pane.runtime.isMainTerminalModelDormant(TRANSCRIPT_PANE_PTY_ID)).toBe(true)
      // Why quiet first: the seed, not the quiet window, is then all the wait holds for.
      vi.useFakeTimers({
        toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
        now: Date.now() + MAIN_TERMINAL_MODEL_DORMANT_AFTER_MS
      })
      const startedAt = Date.now()
      let settledAt = -1
      const waiting = pane.runtime
        .waitForTerminal(pane.handle, { condition: 'tui-idle', timeoutMs: 10_000 })
        .then((result) => {
          settledAt = Date.now()
          return result
        })
      void waiting.catch(() => {})
      await vi.advanceTimersByTimeAsync(10_000)
      await expect(waiting).resolves.toMatchObject({ condition: 'tui-idle', satisfied: true })
      // The 2 s seed timeout, the 1 s backoff, and the next poll (every 2 s) that retries.
      expect(settledAt - startedAt).toBeLessThanOrEqual(5_000)
    },
    20_000
  )

  it("holds OMP's idle title while the screen that vetoes its setup wizard is being rebuilt", async () => {
    // Why OMP: its idle title lands before the wizard opens, and only its screen refuses input.
    const pane = await createQuietAgentPane(
      'omp',
      readRuntimeFixture('omp-18-setup'),
      CODEX_SIZE,
      1_000
    )
    expect(pane.runtime.isMainTerminalModelDormant(TRANSCRIPT_PANE_PTY_ID)).toBe(true)
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
      now: Date.now()
    })
    const waiting = pane.runtime.waitForTerminal(pane.handle, {
      condition: 'tui-idle',
      timeoutMs: 5_000
    })
    void waiting.catch(() => {})
    pane.emitNow('\x1b]0;π > capture-cwd\x07')
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(waiting).rejects.toThrow(/timeout/)
  }, 15_000)

  it('does not settle a dormant Codex pane whose rebuilt screen is still provisional', async () => {
    const data = readRuntimeFixture('codex-0157-fresh-home-daemon-install')
    const install = data.indexOf('Installing daemon')
    expect(install).toBeGreaterThan(0)
    const pane = await createQuietAgentPane(
      'codex',
      data.slice(0, data.indexOf('\n', install) + 1),
      CODEX_SIZE
    )
    expect(pane.runtime.isMainTerminalModelDormant(TRANSCRIPT_PANE_PTY_ID)).toBe(true)
    await expect(waitForIdleFromNow(pane, 6_000)).rejects.toThrow(/timeout/)
  }, 15_000)

  it('reads the rebuilt screen for a one-shot check instead of no screen', async () => {
    const { runtime } = await createQuietAgentPane('claude', 'Do you trust this folder?\r\n')
    expect(runtime.isMainTerminalModelDormant(TRANSCRIPT_PANE_PTY_ID)).toBe(true)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: both readers are protected runtime methods; the test only calls them.
    const internals = runtime as unknown as {
      readLiveTerminalScreenLines(ptyId: string): string[] | null
      readSettledLiveTerminalScreenLines(ptyId: string): Promise<string[] | null>
    }
    const settled = internals.readSettledLiveTerminalScreenLines(TRANSCRIPT_PANE_PTY_ID)
    // The synchronous read sees the rebuild in flight and reports no screen.
    expect(internals.readLiveTerminalScreenLines(TRANSCRIPT_PANE_PTY_ID)).toBeNull()
    expect(await settled).toContain('Do you trust this folder?')
  })
})
