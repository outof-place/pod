import './unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'
import type { RuntimeTerminalWait } from '../../../shared/runtime-types'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamText,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../../shared/terminal-stream-protocol'
import { RUNTIME_LOCAL_STREAM_CONNECTION_ID_PREFIX } from '../../../shared/runtime-local-stream-protocol'
import { makeRequest, stubRuntime } from './terminal-multiplex-test-harness'

type Viewer = {
  outputs: () => string[]
  handlers: Map<number, (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void>
}

describe('Pod input flush for local-stream multiplex viewers', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setImmediate', 'performance'] })
    vi.stubEnv('ORCA_TERMINAL_OUTPUT_LEADING_EDGE', '1')
    vi.stubEnv('POD_TERMINAL_INPUT_FLUSH', '1')
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  function setup() {
    const listeners: ((data: string) => void)[] = []
    const runtime = stubRuntime({
      readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
      serializeTerminalBuffer: vi.fn().mockResolvedValue(null),
      getTerminalSize: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
      getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
      getLayout: vi.fn().mockReturnValue({ seq: 1 }),
      subscribeToTerminalData: vi.fn((_: string, listener: (data: string) => void) => {
        listeners.push(listener)
        return vi.fn()
      }),
      subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
      subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
      subscribeToDriverChanges: vi.fn().mockReturnValue(vi.fn()),
      getTerminalFitOverride: vi.fn().mockReturnValue(null),
      getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
      registerSubscriptionCleanup: vi.fn(),
      cleanupSubscription: vi.fn(),
      waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
      sendTerminal: vi.fn().mockResolvedValue({ accepted: true }),
      handleMobileSubscribe: vi.fn().mockResolvedValue(undefined),
      handleMobileUnsubscribe: vi.fn()
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
    const emit = (data: string): void => {
      for (const listener of listeners) {
        listener(data)
      }
    }

    async function open(connectionId: string, clientType: 'desktop' | 'mobile'): Promise<Viewer> {
      const frames: Uint8Array<ArrayBufferLike>[] = []
      const handlers: Viewer['handlers'] = new Map()
      const messages: string[] = []
      void dispatcher.dispatchStreaming(
        makeRequest('terminal.multiplex', {}),
        (msg) => messages.push(msg),
        {
          connectionId,
          sendBinary: (bytes) => {
            frames.push(bytes)
          },
          registerBinaryStreamHandler: (streamId, handler) => {
            handlers.set(streamId, handler)
            return () => handlers.delete(streamId)
          }
        }
      )
      await vi.waitFor(() => expect(handlers.has(0)).toBe(true))
      handlers.get(0)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.Subscribe,
            streamId: 0,
            seq: 1,
            payload: encodeTerminalStreamJson({
              streamId: 5,
              terminal: 'terminal-1',
              client: { id: `${clientType}-${connectionId}`, type: clientType }
            })
          })
        )!
      )
      await vi.waitFor(() =>
        expect(messages.some((msg) => JSON.parse(msg).result?.type === 'subscribed')).toBe(true)
      )
      return {
        handlers,
        outputs: () =>
          frames
            .map((frame) => decodeTerminalStreamFrame(frame))
            .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
            .map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : ''))
      }
    }

    async function type(viewer: Viewer, text: string): Promise<void> {
      viewer.handlers.get(5)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.Input,
            streamId: 5,
            seq: 0,
            payload: encodeTerminalStreamText(text)
          })
        )!
      )
      await vi.advanceTimersByTimeAsync(0)
    }

    return { emit, open, type, runtime }
  }

  it('speeds up only the local-stream viewer that typed, not a mobile viewer of the same PTY', async () => {
    const { emit, open, type } = setup()
    const local = await open(`${RUNTIME_LOCAL_STREAM_CONNECTION_ID_PREFIX}test`, 'desktop')
    const mobile = await open('ws-connection', 'mobile')
    const mobileTyping = await open('ws-connection-2', 'desktop')

    emit('a')
    vi.advanceTimersByTime(1)
    emit('b')
    await type(local, 'k')
    await type(mobileTyping, 'm')
    await vi.advanceTimersByTimeAsync(1)
    expect(local.outputs()).toEqual(['a', 'b'])
    expect(mobile.outputs()).toEqual(['a'])
    expect(mobileTyping.outputs()).toEqual(['a'])

    // Within the window the local viewer's next batch also uses the short timer.
    emit('c')
    await vi.advanceTimersByTimeAsync(1)
    expect(local.outputs()).toEqual(['a', 'b', 'c'])
    await vi.advanceTimersByTimeAsync(5)
    expect(mobile.outputs()).toEqual(['a', 'bc'])
    expect(mobileTyping.outputs()).toEqual(['a', 'bc'])
  })

  it('keeps the 5 ms timer for local viewers with POD_TERMINAL_INPUT_FLUSH=0', async () => {
    vi.stubEnv('POD_TERMINAL_INPUT_FLUSH', '0')
    const { emit, open, type } = setup()
    const local = await open(`${RUNTIME_LOCAL_STREAM_CONNECTION_ID_PREFIX}test`, 'desktop')
    emit('a')
    vi.advanceTimersByTime(1)
    emit('b')
    await type(local, 'k')
    await vi.advanceTimersByTimeAsync(1)
    expect(local.outputs()).toEqual(['a'])
    await vi.advanceTimersByTimeAsync(5)
    expect(local.outputs()).toEqual(['a', 'b'])
  })
})
