/**
 * Which one view answers a PTY's terminal queries when several are attached.
 *
 * Every view parses the same output, so each would answer every query (DA, CPR, OSC
 * colours) and the program would read two replies. One view is elected: the one with the
 * keyboard (the last to send user input or focus), else the last to claim the viewport,
 * else the oldest desktop stream, else a parsing renderer, else the oldest phone (a passive
 * phone never races the desktop). The others never see queries: the host strips them from
 * their output. With no view at all, main's model answers as before.
 */

export type TerminalQueryResponderKind = 'stream' | 'renderer'

export type TerminalQueryResponderCandidate = {
  key: string
  kind: TerminalQueryResponderKind
  clientId: string | null
  mobile: boolean
  attachedAt: number
  keyboardAt: number
  claimedAt: number
}

const candidatesByPty = new Map<string, Map<string, TerminalQueryResponderCandidate>>()
// Why a counter, not a clock: two signals in one millisecond must still order.
let order = 0
let changeListener: ((ptyId: string) => void) | null = null

/** One listener (the PTY IPC layer): told after any change that can move a PTY's responder. */
export function setTerminalQueryResponderChangeListener(
  listener: ((ptyId: string) => void) | null
): void {
  changeListener = listener
}

/** Registers a view that could answer; the release is idempotent. */
export function attachTerminalQueryResponderCandidate(
  ptyId: string,
  key: string,
  kind: TerminalQueryResponderKind,
  clientId: string | null = null,
  mobile = false
): () => void {
  let candidates = candidatesByPty.get(ptyId)
  if (!candidates) {
    candidates = new Map()
    candidatesByPty.set(ptyId, candidates)
  }
  const candidate = {
    key,
    kind,
    clientId,
    mobile,
    attachedAt: ++order,
    keyboardAt: 0,
    claimedAt: 0
  }
  candidates.set(key, candidate)
  changeListener?.(ptyId)
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    const current = candidatesByPty.get(ptyId)
    if (current?.get(key) === candidate) {
      current.delete(key)
      if (current.size === 0) {
        candidatesByPty.delete(ptyId)
      }
      changeListener?.(ptyId)
    }
  }
}

/** User input or a focus report from this view: it has the keyboard now. */
export function noteTerminalQueryResponderKeyboard(ptyId: string, key: string): void {
  const candidate = candidatesByPty.get(ptyId)?.get(key)
  if (candidate) {
    candidate.keyboardAt = ++order
    changeListener?.(ptyId)
  }
}

export function noteTerminalQueryResponderClaim(ptyId: string, key: string): void {
  const candidate = candidatesByPty.get(ptyId)?.get(key)
  if (candidate) {
    candidate.claimedAt = ++order
    changeListener?.(ptyId)
  }
}

function latest(
  candidates: TerminalQueryResponderCandidate[],
  field: 'keyboardAt' | 'claimedAt'
): TerminalQueryResponderCandidate | null {
  let best: TerminalQueryResponderCandidate | null = null
  for (const candidate of candidates) {
    if (candidate[field] > 0 && (!best || candidate[field] > best[field])) {
      best = candidate
    }
  }
  return best
}

export function terminalQueryResponder(ptyId: string): TerminalQueryResponderCandidate | null {
  const candidates = [...(candidatesByPty.get(ptyId)?.values() ?? [])]
  if (candidates.length === 0) {
    return null
  }
  const oldest = (mobile: boolean): TerminalQueryResponderCandidate | null =>
    candidates.reduce<TerminalQueryResponderCandidate | null>(
      (found, candidate) =>
        candidate.kind === 'stream' &&
        candidate.mobile === mobile &&
        (!found || candidate.attachedAt < found.attachedAt)
          ? candidate
          : found,
      null
    )
  return (
    latest(candidates, 'keyboardAt') ??
    latest(candidates, 'claimedAt') ??
    oldest(false) ??
    candidates.find((candidate) => candidate.kind === 'renderer') ??
    oldest(true)
  )
}

export function isTerminalQueryResponder(ptyId: string, key: string): boolean {
  return terminalQueryResponder(ptyId)?.key === key
}

export function _resetTerminalQueryResponderElectionForTest(): void {
  candidatesByPty.clear()
  order = 0
  changeListener = null
}
