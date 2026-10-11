import { extractOnlyTerminalQueryReplies } from '../../../../../shared/terminal-query-reply'
import type { TerminalOutputMeta } from '../../terminal-output-frame-chunks'
import {
  attachTerminalQueryResponderCandidate,
  isTerminalQueryResponder,
  noteTerminalQueryResponderClaim,
  noteTerminalQueryResponderKeyboard,
  terminalQueryResponder
} from '../../../terminal-query-responder-election'
import { TerminalQueryStripper, extractTerminalQuerySequences } from './terminal-query-stripper'

// Why: a responder that leaves this soon after a query it never answered leaves it to main's model.
export const QUERY_RESPONDER_DETACH_FALLBACK_MS = 1_000
const MAX_UNANSWERED_QUERIES = 32

export type MultiplexQueryResponder = {
  ptyId: string
  key: string
  stripper: TerminalQueryStripper
  unanswered: { at: number; query: string }[]
  release: () => void
}

type QueryResponderStream = {
  queryResponder: MultiplexQueryResponder | null
  outputBatcher: { push: (data: string, meta?: TerminalOutputMeta) => void }
}

export function attachMultiplexQueryResponder(
  ptyId: string,
  key: string,
  clientId: string | null,
  mobile: boolean
): MultiplexQueryResponder {
  return {
    ptyId,
    key,
    stripper: new TerminalQueryStripper(),
    unanswered: [],
    release: attachTerminalQueryResponderCandidate(ptyId, key, 'stream', clientId, mobile)
  }
}

/** Pushes this stream's share of a chunk: as it is for the responder, without queries for any
 *  other view. The choice is made per chunk, so each query reaches exactly one view. */
export function pushMultiplexStreamOutput(
  stream: QueryResponderStream,
  data: string,
  meta?: TerminalOutputMeta
): void {
  const responder = stream.queryResponder
  // Why sourced chunks pass as they are: their ranges map display offsets 1:1 to the source.
  if (!responder || (meta?.sourceRanges?.length ?? 0) > 0) {
    stream.outputBatcher.push(data, meta)
    return
  }
  if (isTerminalQueryResponder(responder.ptyId, responder.key)) {
    const held = responder.stripper.takeHeld()
    if (held) {
      // Why the seq: the held bytes end where this chunk starts; a seq-less span reads as a gap to viewers.
      const heldSeq =
        typeof meta?.seq === 'number' ? meta.seq - (meta.rawLength ?? data.length) : undefined
      stream.outputBatcher.push(held, {
        rawLength: 0,
        transformed: true,
        ...(heldSeq === undefined ? {} : { seq: heldSeq })
      })
    }
    recordForwardedQueries(responder, data)
    stream.outputBatcher.push(data, meta)
    return
  }
  const stripped = responder.stripper.strip(data)
  if (stripped === data) {
    stream.outputBatcher.push(data, meta)
    return
  }
  stream.outputBatcher.push(stripped, {
    ...meta,
    rawLength: meta?.rawLength ?? data.length,
    transformed: true
  })
}

function recordForwardedQueries(responder: MultiplexQueryResponder, data: string): void {
  if (!data.includes('\x1b')) {
    return
  }
  const at = Date.now()
  for (const query of extractTerminalQuerySequences(data)) {
    responder.unanswered.push({ at, query })
  }
  if (responder.unanswered.length > MAX_UNANSWERED_QUERIES) {
    responder.unanswered.splice(0, responder.unanswered.length - MAX_UNANSWERED_QUERIES)
  }
}

/** Input from this stream: replies settle its oldest forwarded queries, anything else is the
 *  user at this view's keyboard. */
export function noteMultiplexStreamInput(responder: MultiplexQueryResponder, text: string): void {
  const replies = extractOnlyTerminalQueryReplies(text)
  if (replies) {
    responder.unanswered.splice(0, replies.length)
    return
  }
  noteTerminalQueryResponderKeyboard(responder.ptyId, responder.key)
}

export function noteMultiplexStreamClaim(responder: MultiplexQueryResponder): void {
  noteTerminalQueryResponderClaim(responder.ptyId, responder.key)
}

/** Leaves the election. A responder's recent queries it never answered go to main's model, so a
 *  detach between a query and its reply never leaves the program without an answer. */
export function releaseMultiplexQueryResponder(
  responder: MultiplexQueryResponder,
  answerFromModel: (ptyId: string, queryData: string) => void
): void {
  const wasResponder = isTerminalQueryResponder(responder.ptyId, responder.key)
  responder.release()
  if (!wasResponder) {
    return
  }
  const since = Date.now() - QUERY_RESPONDER_DETACH_FALLBACK_MS
  const pending = responder.unanswered.filter((entry) => entry.at >= since)
  responder.unanswered = []
  if (pending.length > 0) {
    answerFromModel(responder.ptyId, pending.map((entry) => entry.query).join(''))
  }
}

/** A phone's relayed reply counts only from the elected view; with no view elected, the mobile
 *  floor decides as before. */
export function isMobileQueryReplyResponder(
  runtime: { isMobileTerminalQueryReplyAuthority: (ptyId: string, clientId: string) => boolean },
  ptyId: string,
  clientId: string
): boolean {
  const elected = terminalQueryResponder(ptyId)
  return elected
    ? elected.clientId === clientId
    : runtime.isMobileTerminalQueryReplyAuthority(ptyId, clientId)
}
