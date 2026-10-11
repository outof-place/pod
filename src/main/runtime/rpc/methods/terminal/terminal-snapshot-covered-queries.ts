import type { OrcaRuntimeService } from '../../../orca-runtime'
import { extractHiddenStartupRendererQueryData } from '../../../../../shared/terminal-reply-query-extraction'
import type { TerminalMultiplexStream, TerminalOutputChunk } from './terminal-stream-types'

/** The part of a buffered chunk an initial snapshot at `snapshotSeq` already holds. Mirrors
 *  getOutputAfterSnapshotSeq: what that function drops is covered, what it keeps is not. */
export function getOutputCoveredBySnapshot(
  chunk: TerminalOutputChunk,
  snapshotSeq: number | undefined
): string {
  if (
    typeof snapshotSeq !== 'number' ||
    typeof chunk.meta?.seq !== 'number' ||
    typeof chunk.meta.rawLength !== 'number'
  ) {
    return ''
  }
  if (chunk.meta.seq <= snapshotSeq) {
    return chunk.data
  }
  const chunkStartSeq = chunk.meta.seq - chunk.meta.rawLength
  if (chunkStartSeq >= snapshotSeq) {
    return ''
  }
  return chunk.meta.transformed ? chunk.data : chunk.data.slice(0, snapshotSeq - chunkStartSeq)
}

/**
 * A stream takes reply authority when it registers, and its initial snapshot comes later. Output
 * main took in between went into its model unanswered, and the snapshot covers it, so the viewer
 * never sees those bytes live either: a program that asked for the cursor position or a color then
 * waited (5 s for `orb`, for one) with nobody to answer it. When main held the authority this
 * stream took, main answers the queries in that covered output now. Output after the snapshot goes
 * to the viewer live, and the viewer answers it.
 */
export function answerQueriesCoveredBySnapshot(
  runtime: OrcaRuntimeService,
  stream: TerminalMultiplexStream,
  pendingOutput: readonly TerminalOutputChunk[],
  snapshotSeq: number | undefined
): void {
  if (!stream.modelHeldQueryAuthority) {
    return
  }
  let covered = ''
  for (const chunk of pendingOutput) {
    covered += getOutputCoveredBySnapshot(chunk, snapshotSeq)
  }
  if (!covered.includes('\x1b')) {
    return
  }
  // In output order: a program that sends DA1 after another query reads DA1's reply as "the
  // other one is unsupported" when it arrives first.
  const { orderedQueryData } = extractHiddenStartupRendererQueryData(covered, '')
  if (orderedQueryData.length > 0) {
    runtime.answerTerminalQueriesFromModel(stream.ptyId, orderedQueryData)
  }
}
