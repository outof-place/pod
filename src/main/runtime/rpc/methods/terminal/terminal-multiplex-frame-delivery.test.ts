import { describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame
} from '../../../../../shared/terminal-stream-protocol'
import type { TerminalMultiplexConnection } from './terminal-multiplex-connection'
import { installMultiplexFrameDelivery } from './terminal-multiplex-frame-delivery'

function connection(): { state: TerminalMultiplexConnection; seqs: number[] } {
  const seqs: number[] = []
  const state = {
    closed: false,
    cursor: 40,
    sendBinary: (bytes: Uint8Array) => {
      seqs.push(decodeTerminalStreamFrame(bytes)?.seq ?? -1)
      return true
    },
    emit: vi.fn(),
    closeMultiplex: vi.fn(),
    // Pod: the local-stream backpressure gate (pod/multiplex-backpressure) admits every frame here.
    admitStreamFrame: () => true
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: sendFrame reads only closed, cursor, sendBinary, closeMultiplex and admitStreamFrame; the rest is installed below.
  const multiplex = state as unknown as TerminalMultiplexConnection
  installMultiplexFrameDelivery(multiplex)
  return { state: multiplex, seqs }
}

describe('multiplex frame seq', () => {
  it('stamps seq-less output, spans included, with 0 and control frames with the cursor', () => {
    const { state, seqs } = connection()
    state.sendFrame(7, TerminalStreamOpcode.Output)
    state.sendFrame(7, TerminalStreamOpcode.OutputSpan)
    state.sendFrame(7, TerminalStreamOpcode.OutputSpan, new Uint8Array(), 123)
    state.sendFrame(7, TerminalStreamOpcode.Metadata)
    // A client reads an output frame's seq as the PTY's position; the cursor would read as a jump.
    expect(seqs).toEqual([0, 0, 123, 40])
  })
})
