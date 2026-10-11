import './unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'
import type { RuntimeTerminalDataMeta } from '../orca-runtime'
import type { RuntimeTerminalWait } from '../../../shared/runtime-types'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  type TerminalStreamFrame
} from '../../../shared/terminal-stream-protocol'
import { makeRequest, stubRuntime } from './terminal-multiplex-test-harness'

const SOFT_LIMIT = 1024 * 1024

/** A transport that buffers until the test drains it, refusing bulk past a soft limit. */
function startLink(options: { hardRefuse?: boolean } = {}) {
  const frames: TerminalStreamFrame[] = []
  const messages: string[] = []
  const handlers = new Map<number, (frame: TerminalStreamFrame) => void>()
  const dataListeners = new Map<string, (data: string, meta?: RuntimeTerminalDataMeta) => void>()
  const drainListeners = new Set<() => void>()
  let buffered = 0
  const runtime = stubRuntime({
    resolveLiveLeafForHandle: vi.fn((handle: string) => ({
      ptyId: handle === 'terminal-1' ? 'pty-1' : 'pty-2'
    })),
    readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
    serializeTerminalBuffer: vi.fn().mockResolvedValue({ data: 'seed', cols: 120, rows: 40 }),
    getTerminalSize: vi.fn().mockReturnValue({ cols: 120, rows: 40 }),
    getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
    getLayout: vi.fn().mockReturnValue({ seq: 1 }),
    subscribeToTerminalData: vi.fn((ptyId: string, listener) => {
      dataListeners.set(ptyId, listener)
      return vi.fn()
    }),
    subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
    subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
    subscribeToDriverChanges: vi.fn().mockReturnValue(vi.fn()),
    getTerminalFitOverride: vi.fn().mockReturnValue(null),
    getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
    registerSubscriptionCleanup: vi.fn(),
    waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {}))
  })
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
  const ended = dispatcher
    .dispatchStreaming(makeRequest('terminal.multiplex', {}), (message) => messages.push(message), {
      connectionId: 'local-stream-link-test',
      sendBinary: (bytes) => {
        if (options.hardRefuse) {
          return false
        }
        buffered += bytes.byteLength
        frames.push(decodeTerminalStreamFrame(bytes)!)
        return true
      },
      binaryBackpressure: {
        canAcceptBulk: (frameBytes) => buffered + frameBytes <= SOFT_LIMIT,
        onDrain: (listener) => {
          drainListeners.add(listener)
          return () => drainListeners.delete(listener)
        }
      },
      registerBinaryStreamHandler: (streamId, handler) => {
        handlers.set(streamId, handler)
        return () => handlers.delete(streamId)
      }
    })
    .then(() => true)
  const subscribe = (streamId: number, terminal: string): void =>
    handlers.get(0)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Subscribe,
          streamId: 0,
          seq: streamId,
          payload: encodeTerminalStreamJson({
            streamId,
            terminal,
            client: { id: 'native-1', type: 'desktop' },
            viewport: { cols: 120, rows: 40 }
          })
        })
      )!
    )
  const drain = (): void => {
    buffered = 0
    for (const listener of drainListeners) {
      listener()
    }
  }
  const outputs = (streamId: number): string[] =>
    frames
      .filter(
        (frame) => frame.streamId === streamId && frame.opcode === TerminalStreamOpcode.Output
      )
      .map((frame) => Buffer.from(frame.payload).toString())
  const snapshotReasons = (streamId: number): (string | undefined)[] =>
    frames
      .filter(
        (frame) =>
          frame.streamId === streamId && frame.opcode === TerminalStreamOpcode.SnapshotStart
      )
      .map((frame) => decodeTerminalStreamJson<{ reason?: string }>(frame.payload)?.reason)
  return {
    handlers,
    dataListeners,
    subscribe,
    drain,
    outputs,
    snapshotReasons,
    ended,
    drainListeners
  }
}

async function subscribeBoth(link: ReturnType<typeof startLink>): Promise<void> {
  await vi.waitFor(() => expect(link.handlers.has(0)).toBe(true))
  link.subscribe(7, 'terminal-1')
  link.subscribe(8, 'terminal-2')
  await vi.waitFor(() => {
    expect(link.dataListeners.has('pty-1')).toBe(true)
    expect(link.dataListeners.has('pty-2')).toBe(true)
  })
  await vi.waitFor(() => expect(link.snapshotReasons(8)).toHaveLength(1))
}

describe('terminal multiplex link backpressure', () => {
  it('re-seeds a terminal that flooded the link instead of closing every terminal', async () => {
    const link = startLink()
    await subscribeBoth(link)
    let settled = false
    void link.ended.then(() => {
      settled = true
    })

    const flood = 'x'.repeat(80 * 1024)
    let seq = 0
    for (let chunk = 0; chunk < 20; chunk += 1) {
      seq += flood.length
      link.dataListeners.get('pty-1')!(flood, { seq, rawLength: flood.length })
    }
    await vi.waitFor(() => expect(link.drainListeners.size).toBe(1))
    const delivered = link.outputs(7).reduce((total, output) => total + output.length, 0)
    expect(delivered).toBeLessThan(20 * flood.length)

    link.drain()
    await vi.waitFor(() => expect(link.snapshotReasons(7)).toContain('ack-pending-overflow'))

    link.dataListeners.get('pty-2')!('still-alive', { seq: 11, rawLength: 11 })
    await vi.waitFor(() => expect(link.outputs(8)).toContain('still-alive'))
    link.dataListeners.get('pty-1')!('after-seed', { seq: seq + 10, rawLength: 10 })
    await vi.waitFor(() => expect(link.outputs(7)).toContain('after-seed'))
    expect(settled).toBe(false)
    expect(link.drainListeners.size).toBe(0)
  })

  it('still closes the multiplex when the transport discards a frame outright', async () => {
    const link = startLink({ hardRefuse: true })
    await vi.waitFor(() => expect(link.handlers.has(0)).toBe(true))
    link.subscribe(7, 'terminal-1')
    await expect(link.ended).resolves.toBe(true)
  })
})
