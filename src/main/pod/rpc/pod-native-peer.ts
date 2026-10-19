// Fork-only (Pod): which runtime connections PodNative holds, by the kernel's audit token.
import type { Socket } from 'node:net'
import { homedir, userInfo } from 'node:os'
import { resolve } from 'node:path'
import { getProductIdentity } from '../../product-identity/product-identity'
import {
  POD_UI_PEER_REQUIREMENT,
  type PodPeerCheck,
  type PodPeerVerifier
} from '../ui-host/pod-peer-identity'

// E2E runs only: also PodNative's measure build (build-app.sh --measure), signed by the same team.
export const POD_NATIVE_PEER_E2E_REQUIREMENT =
  'anchor apple generic and certificate leaf[subject.OU] = "75Y2KR6P5W" and ' +
  '(identifier "codes.pod.native" or identifier "codes.pod.native.dev" or ' +
  'identifier "codes.pod.native.measure")'

function accountHome(): string | null {
  try {
    return userInfo().homedir || null
  } catch {
    return null
  }
}

/**
 * An E2E run: an isolated profile (ORCA_E2E_USER_DATA_DIR) and a HOME that isn't the account's own.
 * Only there does a checkout runtime without product identity check PodNative, measure build included.
 */
export function isPodNativePeerE2ERun(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  account: string | null = accountHome()
): boolean {
  return (
    Boolean(env.ORCA_E2E_USER_DATA_DIR) && account !== null && resolve(home) !== resolve(account)
  )
}

/** The code requirement PodNative's connections are checked against in this process. */
export function podNativePeerRequirement(e2e: boolean = isPodNativePeerE2ERun()): string {
  return e2e ? POD_NATIVE_PEER_E2E_REQUIREMENT : POD_UI_PEER_REQUIREMENT
}

let loadVerifier: (() => PodPeerVerifier | null) | null = null
let verifier: PodPeerVerifier | null | undefined

/** The Electron host names its peer-identity addon; orcad names none, so no connection passes. */
export function setPodNativePeerVerifierLoader(load: (() => PodPeerVerifier | null) | null): void {
  loadVerifier = load
  verifier = undefined
}

/** One connection's PodNative check, run on first use only; null without Pod identity outside E2E. */
export function podNativePeerCheck(socket: Socket): (() => PodPeerCheck) | null {
  if (!loadVerifier || (getProductIdentity() === null && !isPodNativePeerE2ERun())) {
    return null
  }
  let result: PodPeerCheck | undefined
  return () => {
    if (!result) {
      if (verifier === undefined) {
        verifier = loadVerifier?.() ?? null
      }
      result = verifier?.(socket) ?? { ok: false, pid: 0, error: 'no peer check available' }
    }
    return result
  }
}

/**
 * Session search consent holds whole transcripts, so beside paired devices only PodNative may flip
 * it, verified by its audit token, for the user's own click. Not the owner token alone: the CLI
 * and any process that reads the runtime metadata hold it too. PodNative's pid, or null.
 */
export function podNativeSearchConsentPid(
  params: { reason?: 'user' },
  peer: (() => PodPeerCheck) | undefined
): number | null {
  if (!peer || params.reason !== 'user') {
    return null
  }
  const check = peer()
  if (!check.ok) {
    console.warn(
      `[ai-vault-search] refused consent from pid ${check.pid}: ${check.error ?? 'not PodNative'}`
    )
    return null
  }
  return check.pid
}
