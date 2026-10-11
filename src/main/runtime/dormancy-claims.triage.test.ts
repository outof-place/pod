// Triage repros for the maintainer's #27086/#27207 findings (stablyai/orca, closed 2026-10-11).
// Each test asserts the behavior main had before dormancy; a failure is the reproduced bug.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TuiAgent } from '../../shared/tui-agent'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'
import { readRuntimeFixture } from './agent-transcript-replay-test-harness'
import { FakeDaemonModel } from './fake-daemon-terminal-model.test-fixture'
import { MAIN_TERMINAL_MODEL_DORMANT_AFTER_MS } from './main-terminal-model-dormancy'
import { createRuntime, syncSinglePty } from './orca-runtime-test-fixtures.spec'
import {
  _resetHiddenRendererPtyDeliveryGateForTest,
  markHiddenRendererPty,
  setDaemonQueryResponderConfirmed
} from '../ipc/pty-hidden-delivery-gate'
import { resolveTerminalQueryResponder } from './terminal-model-query-authority'
import { setPtyHostBindings, noopPtyIpcSurface } from '../ipc/pty-host-bindings'
import { installPtySnapshotIpcHandlers } from '../ipc/pty/ipc/snapshot'
import type { PtyProviderBufferSnapshot } from '../providers/types'

const CODEX_SIZE = { cols: 120, rows: 40 }
const GRID = { cols: 80, rows: 24 }

async function createQuietAgentPane(
  agent: TuiAgent,
  output: string,
  size: { cols: number; rows: number },
  snapshotDelayMs: number | 'never'
) {
  const daemon = new FakeDaemonModel(size)
  const pane = await createTranscriptPane({
    paneTitle: 'Terminal',
    foregroundProcess: null,
    launchAgent: agent,
    size,
    data: '',
    settledDaemonSnapshot: () =>
      snapshotDelayMs === 'never'
        ? new Promise<never>(() => {})
        : new Promise((resolve) => setTimeout(() => resolve(daemon.snapshot()), snapshotDelayMs))
  })
  vi.useFakeTimers({ toFake: ['Date'] })
  const emit = async (data: string): Promise<void> => {
    await daemon.feed(data)
    pane.runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, data, Date.now())
  }
  await emit(output)
  await pane.runtime.readTerminal(pane.handle, { screen: true })
  vi.setSystemTime(Date.now() + MAIN_TERMINAL_MODEL_DORMANT_AFTER_MS)
  await emit('\x1b[?25l')
  return pane
}

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

describe('#27207 triage: a failed seed relaxes readiness', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  // Same recording as the shipped "slow rebuild lands" test: text reads ready, only the screen
  // says busy. Before #27207 main's model stayed live for antigravity, so this wait timed out.
  it('does not report a busy Antigravity pane idle when its rebuild never lands', async () => {
    const pane = await createQuietAgentPane(
      'antigravity',
      readRuntimeFixture('antigravity-1-2-14-busy-streaming'),
      CODEX_SIZE,
      'never'
    )
    expect(pane.runtime.isMainTerminalModelDormant(TRANSCRIPT_PANE_PTY_ID)).toBe(true)
    await expect(waitForIdleFromNow(pane, 6_000)).rejects.toThrow(/timeout/)
  }, 15_000)
})

describe('#27086 triage: rebuilt history depth and recovery fallback', () => {
  let now = 1_000_000

  beforeEach(() => {
    _resetHiddenRendererPtyDeliveryGateForTest()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    setPtyHostBindings({})
    _resetHiddenRendererPtyDeliveryGateForTest()
  })

  function createHarness() {
    const daemon = new FakeDaemonModel(GRID)
    const providerFails = { value: false }
    const runtime = createRuntime()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      getSize: () => GRID,
      canProvideSettledBufferSnapshot: () => true,
      hasRendererSerializer: () => true,
      // Like the real daemon: honors the requested depth, up to its own 5,000-row scrollback.
      serializeProviderBuffer: async (_ptyId, opts): Promise<PtyProviderBufferSnapshot | null> => {
        if (providerFails.value) {
          return null
        }
        const snapshot = daemon.emulator.getSnapshot({ scrollbackRows: opts?.scrollbackRows ?? 0 })
        return {
          data: snapshot.rehydrateSequences + snapshot.snapshotAnsi,
          ...(snapshot.scrollbackAnsi ? { scrollbackAnsi: snapshot.scrollbackAnsi } : {}),
          cols: snapshot.cols,
          rows: snapshot.rows,
          seq: daemon.seq,
          source: 'headless',
          alternateScreen: snapshot.modes.alternateScreen
        }
      }
    })
    syncSinglePty(runtime, 'pty-1')
    const emit = async (data: string): Promise<void> => {
      await daemon.feed(data)
      runtime.onPtyData('pty-1', data, now)
    }
    // Every line-N row in the serialized image, scrollback included, in order.
    const modelLines = async (scrollbackRows: number): Promise<string[]> => {
      const snapshot = await runtime.serializeMainTerminalBuffer('pty-1', { scrollbackRows })
      return `${snapshot?.scrollbackAnsi ?? ''}${snapshot?.data ?? ''}`.match(/line-\d+/g) ?? []
    }
    return { runtime, emit, modelLines, providerFails }
  }

  async function fillThenRestThenWake(harness: ReturnType<typeof createHarness>): Promise<void> {
    let lines = ''
    for (let i = 1; i <= 3000; i += 1) {
      lines += `line-${i}\r\n`
    }
    await harness.emit(lines)
    now += MAIN_TERMINAL_MODEL_DORMANT_AFTER_MS
    await harness.emit('rest\r\n')
    expect(harness.runtime.isMainTerminalModelDormant('pty-1')).toBe(true)
    // A reader wakes it: main rebuilds from the daemon seed.
    await harness.runtime.serializeMainTerminalBuffer('pty-1')
    expect(harness.runtime.isMainTerminalModelDormant('pty-1')).toBe(false)
  }

  it('keeps the history main held before it rested', async () => {
    const harness = createHarness()
    let lines = ''
    for (let i = 1; i <= 3000; i += 1) {
      lines += `line-${i}\r\n`
    }
    await harness.emit(lines)
    const before = await harness.modelLines(5000)
    expect(before[0]).toBe('line-1')
    now += MAIN_TERMINAL_MODEL_DORMANT_AFTER_MS
    await harness.emit('rest\r\n')
    expect(harness.runtime.isMainTerminalModelDormant('pty-1')).toBe(true)
    const after = await harness.modelLines(5000)
    // Bug: the rebuild seeds DORMANT_MODEL_SEED_SCROLLBACK_ROWS (1,000) rows.
    expect({ rows: after.length, first: after[0] }).toEqual({ rows: 3000, first: 'line-1' })
  })

  it('does not hand the rebuilt partial model to the renderer when the daemon recovery fails', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    setPtyHostBindings({
      ipc: {
        ...noopPtyIpcSurface,
        handle: (channel, listener) => {
          handlers.set(channel, listener as (...args: unknown[]) => unknown)
        }
      }
    })
    const harness = createHarness()
    installPtySnapshotIpcHandlers({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test runtime is the real class.
      runtime: harness.runtime as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only get() is read.
      pendingData: { get: () => undefined } as never
    })
    await fillThenRestThenWake(harness)
    expect(harness.runtime.prefersProviderRecoverySnapshot('pty-1')).toBe(true)
    harness.providerFails.value = true
    const snapshot = (await handlers.get('pty:getMainBufferSnapshot')!(null, {
      id: 'pty-1',
      opts: { scrollbackRows: 10_000 }
    })) as { data: string; scrollbackAnsi?: string } | null
    // Like the data-gap path (providerSnapshotRequired): unavailable, never a shallower image the
    // renderer would restore over its own fuller scrollback.
    const rows = snapshot
      ? (`${snapshot.scrollbackAnsi ?? ''}${snapshot.data}`.match(/line-\d+/g) ?? []).length
      : 0
    expect({ snapshot: snapshot === null, rows }).toEqual({ snapshot: true, rows: 0 })
  })
})

describe('#27123 triage: remote viewer attaching to a delegated pane', () => {
  let now = 1_000_000

  beforeEach(() => {
    _resetHiddenRendererPtyDeliveryGateForTest()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    _resetHiddenRendererPtyDeliveryGateForTest()
  })

  // A remote view answers every query it parses live (view authority); until the daemon's
  // in-order false marker, main still attributes chunks to the daemon, which answered them at
  // emit time. Exactly one responder per chunk means: viewer attached => the daemon is not it.
  it('has a single responder for bytes that arrive between the viewer attach and the marker', async () => {
    const daemon = new FakeDaemonModel(GRID)
    const requests: boolean[] = []
    const runtime = createRuntime()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      getSize: () => GRID,
      canProvideSettledBufferSnapshot: () => true,
      hasRendererSerializer: () => true,
      serializeProviderBuffer: async () => daemon.snapshot(),
      canDelegateDaemonQueryResponder: () => true,
      setDaemonQueryResponder: (_ptyId, responder) => {
        requests.push(responder)
        return true
      }
    })
    syncSinglePty(runtime, 'pty-1')
    await daemon.feed('one\r\n')
    runtime.onPtyData('pty-1', 'one\r\n', now)
    markHiddenRendererPty('pty-1')
    setDaemonQueryResponderConfirmed('pty-1', true)
    runtime.noteDaemonQueryResponderMarker('pty-1', true)
    expect(requests).toEqual([true])

    const releaseViewer = runtime.registerRemoteTerminalViewSubscriber('pty-1')
    expect(requests).toEqual([true, false])
    // In flight: emitted (and answered) by the daemon before it saw the take-back.
    const responder = resolveTerminalQueryResponder({
      ptyId: 'pty-1',
      settings: undefined,
      hasRemoteViewSubscriber: runtime.hasRemoteTerminalViewSubscriber('pty-1')
    })
    expect({ viewerAttached: runtime.hasRemoteTerminalViewSubscriber('pty-1'), responder }).toEqual(
      { viewerAttached: true, responder: 'view' }
    )
    releaseViewer()
  })
})
