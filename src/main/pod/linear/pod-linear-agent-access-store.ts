// Fork-only (Pod): agent access to Linear, sealed like the key in Pod's own Linear store. The
// settings file is plain JSON that any of the user's processes can edit, so an agent could turn
// its own access on there; it can't forge a sealed value. Anything that doesn't unseal to "on"
// reads as off: a missing, edited or foreign file, no keychain, or a seal anyone could forge.
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
  // After the file check: without a file, nothing touches the keychain.
  if (isPodLinearSealForgeable()) {
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
  if (enabled && isPodLinearSealForgeable()) {
    throw new Error(POD_LINEAR_AGENT_ACCESS_FORGEABLE_MESSAGE)
  }
  const path = agentAccessPath()
  ensurePodLinearDir(podLinearStoreDir())
  writePodLinearKey(path, enabled ? AGENT_ACCESS_ON : AGENT_ACCESS_OFF)
  cached = { path, enabled }
}
