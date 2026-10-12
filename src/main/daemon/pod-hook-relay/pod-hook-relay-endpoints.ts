// Fork-only (Pod): the runtime endpoint files the relay may use. The relay reads the endpoint file a
// hook names and writes its spool beside it, so it takes only a path one of this daemon's own
// sessions was spawned with (pty-subprocess.ts), never one a request makes up.
import { livePodLaneSession } from '../pod-lane/pod-lane-sessions'

/** A session registers once its PTY is up (terminal-host-session-create.ts); its spawn env counts
 *  this long before that, and after a session that never came up. */
const UNREGISTERED_GRACE_MS = 60_000

type Spawned = { endpoint: string; at: number }

/** Null until the relay runs: without it nothing asks, and nothing should pile up. */
let spawned: Map<string, Spawned> | null = null

export function enablePodHookRelayEndpoints(): void {
  spawned ??= new Map()
}

export function disablePodHookRelayEndpoints(): void {
  spawned = null
}

function prune(sessions: Map<string, Spawned>, now: number): void {
  for (const [sessionId, entry] of sessions) {
    if (now - entry.at > UNREGISTERED_GRACE_MS && !livePodLaneSession(sessionId)) {
      sessions.delete(sessionId)
    }
  }
}

/** The endpoint a PTY's hooks report to, as the daemon spawned it. */
export function notePodHookRelaySpawnEnv(
  sessionId: string,
  env: Readonly<Record<string, string | undefined>>,
  now: number = Date.now()
): void {
  if (!spawned) {
    return
  }
  prune(spawned, now)
  const endpoint = env.ORCA_AGENT_HOOK_ENDPOINT
  if (endpoint?.startsWith('/')) {
    spawned.set(sessionId, { endpoint, at: now })
  } else {
    spawned.delete(sessionId)
  }
}

/** True when a live session, or one spawned within the grace, was given exactly this path. */
export function podHookRelayEndpointAllowed(endpoint: string, now: number = Date.now()): boolean {
  if (!spawned) {
    return false
  }
  prune(spawned, now)
  for (const entry of spawned.values()) {
    if (entry.endpoint === endpoint) {
      return true
    }
  }
  return false
}
