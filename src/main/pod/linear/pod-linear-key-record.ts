// Fork-only (Pod): what a workspace's sealed key file holds: the key and the random id of the
// connection that stored it, one sealed value. Every Connect makes a new id, even for the same key,
// so agent access granted to an earlier connection doesn't carry over to a later one.
import { randomBytes } from 'node:crypto'

export type LinearKeyRecord = { key: string; connectionId: string | null }

// Known once a workspace's key was saved or read in this process; per profile, as the token cache.
const connectionIds = new Map<string, string | null>()

export function newLinearConnectionId(): string {
  return randomBytes(16).toString('hex')
}

export function encodeLinearKeyRecord(key: string, connectionId: string): string {
  return JSON.stringify({ v: 1, key, connectionId })
}

/** The key and its connection id; a plain key (stored before ids) has none. */
export function decodeLinearKeyRecord(text: string): LinearKeyRecord | null {
  if (!text.startsWith('{')) {
    return { key: text, connectionId: null }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const field = (key: string): unknown =>
    typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, key) : undefined
  const key = field('key')
  const connectionId = field('connectionId')
  return field('v') === 1 && typeof key === 'string' && key.length > 0
    ? { key, connectionId: typeof connectionId === 'string' ? connectionId : null }
    : null
}

export function rememberLinearConnectionId(workspaceId: string, connectionId: string | null): void {
  connectionIds.set(workspaceId, connectionId)
}

export function forgetLinearConnectionId(workspaceId: string): void {
  connectionIds.delete(workspaceId)
}

/** The workspace's connection id; undefined until its key was saved or read in this process. */
export function knownLinearConnectionId(workspaceId: string): string | null | undefined {
  return connectionIds.get(workspaceId)
}
