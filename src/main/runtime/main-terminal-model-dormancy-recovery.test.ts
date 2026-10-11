// A dormant model's rebuild keeps the history main held, and recovery never hands a partial one out.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeDaemonModel } from './fake-daemon-terminal-model.test-fixture'
import { MAIN_TERMINAL_MODEL_DORMANT_AFTER_MS } from './main-terminal-model-dormancy'
import { createRuntime, syncSinglePty } from './orca-runtime-test-fixtures.spec'
import { _resetHiddenRendererPtyDeliveryGateForTest } from '../ipc/pty-hidden-delivery-gate'
import { setPtyHostBindings, noopPtyIpcSurface } from '../ipc/pty-host-bindings'
import { installPtySnapshotIpcHandlers } from '../ipc/pty/ipc/snapshot'
import type { PtyProviderBufferSnapshot } from '../providers/types'

const GRID = { cols: 80, rows: 24 }

describe("main's terminal model rebuilt after dormancy", () => {
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
    expect({ rows: after.length, first: after[0] }).toEqual({ rows: 3000, first: 'line-1' })
  })

  it('does not hand the rebuilt partial model to the renderer when the daemon recovery fails', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    setPtyHostBindings({
      ipc: {
        ...noopPtyIpcSurface,
        handle: (channel, listener) => {
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler ignores its event argument.
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
    const snapshot: unknown = await handlers.get('pty:getMainBufferSnapshot')?.(null, {
      id: 'pty-1',
      opts: { scrollbackRows: 10_000 }
    })
    // Like the data-gap path (providerSnapshotRequired): unavailable, never a shallower image the
    // renderer would restore over its own fuller scrollback.
    expect(snapshot).toBeNull()
  })
})
