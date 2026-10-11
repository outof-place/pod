import './unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson
} from '../../../shared/terminal-stream-protocol'
import { HeadlessEmulator } from '../../daemon/headless-emulator'
import { startDesktopMultiplexSubscribe } from './terminal-multiplex-test-harness'

async function snapshotAt120(): Promise<{ data: string; cols: number; rows: number }> {
  const model = new HeadlessEmulator({ cols: 120, rows: 40 })
  await model.write(`${'x'.repeat(110)}\r\n% `)
  const snapshot = model.getSnapshot({ scrollbackRows: 1000 })
  model.dispose()
  return {
    data: (snapshot.scrollbackAnsi ?? '') + snapshot.rehydrateSequences + snapshot.snapshotAnsi,
    cols: snapshot.cols,
    rows: snapshot.rows
  }
}

async function subscribedSnapshotSize(
  viewport: { cols: number; rows: number },
  clientType: 'desktop' | 'mobile' = 'desktop'
): Promise<{ subscribed: { cols: number }; start: { cols: number; rows: number } }> {
  const serialized = await snapshotAt120()
  const harness = startDesktopMultiplexSubscribe({
    serializeTerminalBuffer: vi.fn().mockResolvedValue(serialized),
    handleMobileSubscribe: vi.fn().mockResolvedValue(undefined)
  })
  await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
  const subscribe = decodeTerminalStreamFrame(
    encodeTerminalStreamFrame({
      opcode: TerminalStreamOpcode.Subscribe,
      streamId: 0,
      seq: 1,
      payload: encodeTerminalStreamJson({
        streamId: 7,
        terminal: 'terminal-1',
        client: { id: 'viewer-1', type: clientType },
        capabilities: { ackOutput: 1, desktopViewportClaims: 1 },
        viewport
      })
    })
  )
  if (subscribe) {
    harness.handlers.get(0)?.(subscribe)
  }
  const startFrame = await vi.waitFor(() => {
    const frame = harness.binaryFrames
      .map(decodeTerminalStreamFrame)
      .find((candidate) => candidate?.opcode === TerminalStreamOpcode.SnapshotStart)
    expect(frame).toBeDefined()
    return frame
  })
  const subscribed = harness.messages
    .map((message) => JSON.parse(message).result)
    .find((event) => event?.type === 'subscribed')
  harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
  return {
    subscribed,
    start: decodeTerminalStreamJson(startFrame?.payload ?? new Uint8Array()) ?? { cols: 0, rows: 0 }
  }
}

describe('multiplex attach snapshot for a viewer of another size', () => {
  it('rewraps the snapshot to the grid a desktop viewer seeds it at', async () => {
    const { subscribed, start } = await subscribedSnapshotSize({ cols: 100, rows: 30 })
    expect(start).toMatchObject({ cols: 100, rows: 30 })
    expect(subscribed.cols).toBe(100)
  })

  it('keeps the PTY-sized snapshot for a viewer of that size and for mobile', async () => {
    expect((await subscribedSnapshotSize({ cols: 120, rows: 40 })).start).toMatchObject({
      cols: 120,
      rows: 40
    })
    expect((await subscribedSnapshotSize({ cols: 100, rows: 30 }, 'mobile')).start).toMatchObject({
      cols: 120
    })
  })
})
