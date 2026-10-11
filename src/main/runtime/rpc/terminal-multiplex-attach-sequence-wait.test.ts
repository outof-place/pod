// A viewer's subscribe can be what attaches a relaunched main to a live daemon session. Until that
// attach syncs main's output count to the daemon's, output carries main's own count; the attach
// snapshot waits for the sync so its seq and the output behind it share one domain.
import './unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalDataMeta } from '../orca-runtime'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  decodeTerminalStreamText
} from '../../../shared/terminal-stream-protocol'
import {
  sendDesktopMultiplexSubscribe,
  startDesktopMultiplexSubscribe
} from './terminal-multiplex-test-harness'

describe('multiplex attach snapshot during a subscriber-driven attach', () => {
  it('waits for the attach, then sends output after the synced snapshot only', async () => {
    let settleAttach: () => void = () => {}
    const attached = new Promise<void>((resolve) => {
      settleAttach = resolve
    })
    const listeners: ((data: string, meta?: RuntimeTerminalDataMeta) => void)[] = []
    let modelSeq = 0
    const harness = startDesktopMultiplexSubscribe({
      waitForSubscriberDrivenProviderAttach: vi.fn(() => attached),
      subscribeToTerminalData: vi.fn((_ptyId, next) => {
        listeners.push(next)
        return vi.fn()
      }),
      serializeTerminalBuffer: vi.fn(async () => ({
        data: 'screen',
        cols: 120,
        rows: 40,
        seq: modelSeq
      }))
    })
    await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
    sendDesktopMultiplexSubscribe(harness.handlers)
    await vi.waitFor(() => expect(listeners).toHaveLength(1))
    // Before the sync main counts from zero; the daemon is at 5000.
    listeners[0]?.('early\r\n', { seq: 7, rawLength: 7 })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const decoded = () => harness.binaryFrames.map((frame) => decodeTerminalStreamFrame(frame))
    expect(decoded().some((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotStart)).toBe(
      false
    )

    modelSeq = 5007
    settleAttach()
    await vi.waitFor(() =>
      expect(decoded().some((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotEnd)).toBe(
        true
      )
    )
    listeners[0]?.('late\r\n', { seq: 5013, rawLength: 6 })
    await vi.waitFor(() =>
      expect(decoded().some((frame) => frame?.opcode === TerminalStreamOpcode.Output)).toBe(true)
    )
    const start = decoded().find((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotStart)
    expect(decodeTerminalStreamJson(start?.payload ?? new Uint8Array())).toMatchObject({
      seq: 5007
    })
    const outputs = decoded().filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
    expect(
      outputs.map((frame) => decodeTerminalStreamText(frame?.payload ?? new Uint8Array()))
    ).toEqual(['late\r\n'])
    expect(outputs.every((frame) => (frame?.seq ?? 0) > 5007)).toBe(true)
    harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
  })
})
