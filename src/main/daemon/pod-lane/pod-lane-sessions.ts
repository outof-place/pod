// Fork-only (Pod): the sessions a direct lane can tap, registered where they are made, so the lane
// needs no hook in TerminalHost. Weak: a reaped session goes with its last reference.
import type { Session } from '../session'

const sessions = new Map<string, WeakRef<Session>>()

export function registerPodLaneSession(session: Session): void {
  sessions.set(session.sessionId, new WeakRef(session))
}

export function livePodLaneSession(sessionId: string): Session | null {
  const session = sessions.get(sessionId)?.deref()
  if (session?.isAlive) {
    return session
  }
  sessions.delete(sessionId)
  return null
}
