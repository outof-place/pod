// Fork-only (Pod): which runtime connections PodNative holds, by the kernel's audit token.
import type { Socket } from 'node:net'
import { getProductIdentity } from '../../product-identity/product-identity'
import type { PodPeerCheck, PodPeerVerifier } from '../ui-host/pod-peer-identity'

let loadVerifier: (() => PodPeerVerifier | null) | null = null
let verifier: PodPeerVerifier | null | undefined

/** The Electron host names its peer-identity addon; orcad names none, so no connection passes. */
export function setPodNativePeerVerifierLoader(load: (() => PodPeerVerifier | null) | null): void {
  loadVerifier = load
  verifier = undefined
}

/** One connection's PodNative check, run on first use only; null without Pod identity. */
export function podNativePeerCheck(socket: Socket): (() => PodPeerCheck) | null {
  if (!loadVerifier || getProductIdentity() === null) {
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
