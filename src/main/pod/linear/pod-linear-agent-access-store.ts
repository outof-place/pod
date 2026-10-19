// Fork-only (Pod): agent access to Linear, sealed like the key in Pod's own Linear store. The
// settings file is plain JSON that any of the user's processes can edit, so an agent could turn
// its own access on there; it can't forge a sealed value. Anything that doesn't unseal to "on"
// reads as off: a missing, edited or foreign file, or no keychain.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ensurePodLinearDir,
  podLinearStoreDir,
  readPodLinearKey,
  writePodLinearKey
} from './pod-linear-key-store'

const AGENT_ACCESS_ON = 'pod-linear-agent-access:on'
const AGENT_ACCESS_OFF = 'pod-linear-agent-access:off'

// Why cached: admission reads it on every agent call. Only Pod's own write changes it; per path, so
// another profile (a test's userData) reads its own file.
let cached: { path: string; enabled: boolean } | undefined

function agentAccessPath(): string {
  return join(podLinearStoreDir(), 'agent-access.enc')
}

function readSealed(path: string): boolean {
  let raw: Buffer
  try {
    raw = readFileSync(path)
  } catch {
    return false
  }
  try {
    return readPodLinearKey(raw) === AGENT_ACCESS_ON
  } catch {
    return false
  }
}

export function readSealedLinearAgentAccess(): boolean {
  const path = agentAccessPath()
  if (cached?.path !== path) {
    cached = { path, enabled: readSealed(path) }
  }
  return cached.enabled
}

/** Seals the new value; throws, changing nothing, when the keychain can't seal it. */
export function writeSealedLinearAgentAccess(enabled: boolean): void {
  const path = agentAccessPath()
  ensurePodLinearDir(podLinearStoreDir())
  writePodLinearKey(path, enabled ? AGENT_ACCESS_ON : AGENT_ACCESS_OFF)
  cached = { path, enabled }
}
