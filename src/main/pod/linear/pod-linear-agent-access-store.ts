// Fork-only (Pod): agent access to Linear, sealed like the key in Pod's own Linear store. The
// settings file is plain JSON that any of the user's processes can edit, so an agent could turn
// its own access on there; it can't forge a sealed value. Access holds the connection ids of the
// workspaces it was granted for (pod-linear-key-record.ts): a later Connect makes a new id, so a
// copy of an earlier grant opens nothing. Anything that doesn't unseal to a grant reads as off: a
// missing, edited, foreign or older file, no keychain, or a seal anyone could forge.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ensurePodLinearDir,
  isPodLinearSealForgeable,
  podLinearStoreDir,
  readPodLinearKey,
  writePodLinearKey
} from './pod-linear-key-store'

export const POD_LINEAR_AGENT_ACCESS_FORGEABLE_MESSAGE =
  "Pod turns on agent access to Linear only with the system keychain's seal, and this run's keychain can't give one."
export const POD_LINEAR_AGENT_ACCESS_NO_WORKSPACE_MESSAGE =
  'Connect a Linear workspace before turning on agent access.'

const NONE: ReadonlySet<string> = new Set()

// Why cached: admission reads it on every agent call. Only Pod's own write changes it; per path, so
// another profile (a test's userData) reads its own file.
let cached: { path: string; connectionIds: ReadonlySet<string> } | undefined

function agentAccessPath(): string {
  return join(podLinearStoreDir(), 'agent-access.enc')
}

function decodeGrant(text: string): ReadonlySet<string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return NONE
  }
  const field = (key: string): unknown =>
    typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, key) : undefined
  const ids = field('connectionIds')
  if (field('v') !== 1 || field('on') !== true || !Array.isArray(ids)) {
    return NONE
  }
  return new Set(ids.filter((id): id is string => typeof id === 'string' && id.length >= 32))
}

function readSealed(path: string): ReadonlySet<string> {
  let raw: Buffer
  try {
    raw = readFileSync(path)
  } catch {
    return NONE
  }
  // After the file check: without a file, nothing touches the keychain.
  if (isPodLinearSealForgeable()) {
    return NONE
  }
  try {
    const text = readPodLinearKey(raw)
    return text === null ? NONE : decodeGrant(text)
  } catch {
    return NONE
  }
}

/** The connection ids agent access was granted for; empty means off. */
export function linearAgentAccessConnectionIds(): ReadonlySet<string> {
  const path = agentAccessPath()
  if (cached?.path !== path) {
    cached = { path, connectionIds: readSealed(path) }
  }
  return cached.connectionIds
}

export function readSealedLinearAgentAccess(): boolean {
  return linearAgentAccessConnectionIds().size > 0
}

/**
 * Seals a grant for `connectionIds` (the workspaces connected now), or off; throws, changing nothing,
 * when the keychain can't seal it or there is nothing to grant.
 */
export function writeSealedLinearAgentAccess(enabled: boolean, connectionIds: string[] = []): void {
  if (enabled && isPodLinearSealForgeable()) {
    throw new Error(POD_LINEAR_AGENT_ACCESS_FORGEABLE_MESSAGE)
  }
  if (enabled && connectionIds.length === 0) {
    throw new Error(POD_LINEAR_AGENT_ACCESS_NO_WORKSPACE_MESSAGE)
  }
  const path = agentAccessPath()
  const grant = enabled ? { v: 1, on: true, connectionIds } : { v: 1, on: false }
  ensurePodLinearDir(podLinearStoreDir())
  writePodLinearKey(path, JSON.stringify(grant))
  cached = { path, connectionIds: enabled ? new Set(connectionIds) : NONE }
}
