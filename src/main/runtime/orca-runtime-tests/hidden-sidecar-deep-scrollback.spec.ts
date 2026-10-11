// Why: a hidden pane with a raw-byte sidecar and more scrollback than main's model keeps its view
// parsing, as before sidecar-only delivery: a reveal restored from that model would cut its history.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetHiddenRendererPtyDeliveryGateForTest,
  markHiddenRendererPty,
  rendererPtyViewDelivery,
  setRendererPtyDeliveryInterest
} from '../../ipc/pty-hidden-delivery-gate'
import { MAIN_TERMINAL_MODEL_DORMANT_AFTER_MS } from '../main-terminal-model-dormancy'
import { FakeDaemonModel } from '../fake-daemon-terminal-model.test-fixture'
import { createRuntime, store, syncSinglePty } from '../orca-runtime-test-fixtures.spec'

const GRID = { cols: 80, rows: 24 }

let now = 1_000_000

function createHarness(scrollbackRows: number) {
  const settings = Object.assign(store.getSettings(), { terminalScrollbackRows: scrollbackRows })
  vi.spyOn(store, 'getSettings').mockReturnValue(settings)
  const daemon = new FakeDaemonModel(GRID)
  const runtime = createRuntime()
  const replies: string[] = []
  const requests: boolean[] = []
  runtime.setPtyController({
    write: (_ptyId, data, inputKind) => {
      if (inputKind === 'query-reply') {
        replies.push(data)
      }
      return true
    },
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
  const emit = async (data: string): Promise<void> => {
    await daemon.feed(data)
    runtime.onPtyData('pty-1', data, now)
  }
  return { runtime, settings, replies, requests, emit }
}

describe('hidden sidecar pane deeper than main terminal model', () => {
  beforeEach(() => {
    _resetHiddenRendererPtyDeliveryGateForTest()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    _resetHiddenRendererPtyDeliveryGateForTest()
  })

  it('keeps the view parsing and answering, so neither the daemon nor main takes its queries', async () => {
    const { runtime, settings, replies, requests, emit } = createHarness(50_000)
    await emit('one\r\n')
    setRendererPtyDeliveryInterest('pty-1', true)
    markHiddenRendererPty('pty-1')
    expect(requests).toEqual([])
    expect(rendererPtyViewDelivery('pty-1', settings)).toBe('parse')

    await emit('\x1b[6n')
    await runtime.serializeMainTerminalBuffer('pty-1')
    expect(replies).toEqual([])

    now += MAIN_TERMINAL_MODEL_DORMANT_AFTER_MS
    await emit('quiet\r\n')
    expect(runtime.isMainTerminalModelDormant('pty-1')).toBe(true)
    expect(requests).toEqual([])
  })

  it('still sends sidecar-only bytes and delegates at the default depth', async () => {
    const { settings, requests, emit } = createHarness(5_000)
    await emit('one\r\n')
    setRendererPtyDeliveryInterest('pty-1', true)
    markHiddenRendererPty('pty-1')
    expect(requests).toEqual([true])
    expect(rendererPtyViewDelivery('pty-1', settings)).toBe('sidecarsOnly')
  })
})
