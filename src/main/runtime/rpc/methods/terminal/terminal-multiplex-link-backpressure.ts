import { TerminalStreamOpcode } from '../../../../../shared/terminal-stream-protocol'
import { TERMINAL_MULTIPLEX_ACK_BATCH_BYTES } from '../../../../../shared/terminal-multiplex-flow-control'
import type { TerminalMultiplexConnection } from './terminal-multiplex-connection'
import type { TerminalMultiplexStream } from './terminal-stream-types'

// Why: these carry a terminal's bulk; a refused one costs that terminal a re-seed, while small
// control frames keep the headroom the transport reserves for them.
const BULK_OPCODES: ReadonlySet<TerminalStreamOpcode> = new Set([
  TerminalStreamOpcode.Output,
  TerminalStreamOpcode.OutputSpan,
  TerminalStreamOpcode.SnapshotChunk
])

/**
 * Per-terminal backpressure on a transport that reports its own fill: one terminal flooding the
 * link stops being sent and is re-seeded from a snapshot once the link drains, instead of the
 * whole multiplex closing for every terminal on it.
 */
export function installMultiplexLinkBackpressure(state: TerminalMultiplexConnection): void {
  const link = state.binaryBackpressure
  let unsubscribeDrain: (() => void) | null = null

  const releaseDrain = (): void => {
    unsubscribeDrain?.()
    unsubscribeDrain = null
  }

  const reseedOverflowedStreams = (): void => {
    if (!link || state.closed) {
      releaseDrain()
      return
    }
    for (const stream of state.streams.values()) {
      if (!stream.linkOverflowed) {
        continue
      }
      if (!link.canAcceptBulk(TERMINAL_MULTIPLEX_ACK_BATCH_BYTES)) {
        return
      }
      stream.linkOverflowed = false
      void state.sendAckRecoverySnapshot(stream)
    }
    if (![...state.streams.values()].some((stream) => stream.linkOverflowed)) {
      releaseDrain()
    }
  }

  const overflow = (stream: TerminalMultiplexStream): void => {
    stream.linkOverflowed = true
    // Why: queued output is older than the re-seed, which replaces the screen and its history.
    stream.ackPendingOutput = []
    stream.ackPendingOutputBytes = 0
    stream.ackPendingOutputOverflowed = true
    unsubscribeDrain ??= link?.onDrain(reseedOverflowedStreams) ?? null
  }

  state.admitStreamFrame = (streamId, opcode, frameBytes): boolean => {
    const stream = link && BULK_OPCODES.has(opcode) ? state.streams.get(streamId) : undefined
    if (!link || !stream) {
      return true
    }
    if (stream.linkOverflowed) {
      return false
    }
    if (link.canAcceptBulk(frameBytes)) {
      return true
    }
    overflow(stream)
    return false
  }
  state.releaseLinkBackpressure = releaseDrain
}
