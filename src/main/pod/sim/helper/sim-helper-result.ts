// Fork-only (Pod): what a call to the simulator helper answers. Nothing here throws into the pool:
// a helper that cannot run, crashed or hung is `unavailable` with a reason, and a helper that
// refused a call answers with its typed error code.
import type { SimHelperErrorCode } from './sim-helper-protocol'

export type SimHelperUnavailableReason =
  | 'notMacOS'
  // No pod-sim binary at any candidate path (dev checkout not built, or a packaging gap).
  | 'notFound'
  | 'spawnFailed'
  // The helper did not accept this spawn's token: a wrapper dropped the environment, or not pod-sim.
  | 'tokenMismatch'
  | 'protocolMismatch'
  | 'badHello'
  | 'crashed'
  | 'timeout'
  | 'stopped'

export type SimHelperFailure =
  | { kind: 'unavailable'; reason: SimHelperUnavailableReason; message: string }
  | { kind: 'error'; code: SimHelperErrorCode; message: string }

export type SimHelperResult<T> = { ok: true; value: T } | { ok: false; failure: SimHelperFailure }

export function simHelperUnavailable(
  reason: SimHelperUnavailableReason,
  detail?: string
): SimHelperFailure {
  return {
    kind: 'unavailable',
    reason,
    message: `helper unavailable: ${reason}${detail ? ` (${detail})` : ''}`
  }
}

export function simHelperFailed<T>(failure: SimHelperFailure): SimHelperResult<T> {
  return { ok: false, failure }
}
