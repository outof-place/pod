// Fork-only (Pod): OrbStack failures a user can act on, in Pod's words.
import type { PodOrbstackActionResult } from '../../../shared/pod-orbstack-types'

// Why: OrbStack 2.2.3 keeps the address of every machine it deleted, so after a few hundred
// creates (Pod's clones and sandboxes count) a new machine never gets an IPv4 address and orb
// says "machine didn't start in 30s (missing IP address)". orbstack/orbstack#2688; a restart
// does not always free them.
const MISSING_IP = /missing IP address/i

export const POD_ORBSTACK_OUT_OF_ADDRESSES_MESSAGE =
  'OrbStack ran out of addresses for new machines; restart OrbStack. If new machines still fail after that, update OrbStack: some versions keep the addresses of deleted machines for about a day.'

/** A failure whose cause the user can act on, explained; any other result as it was. */
export function explainPodOrbstackFailure(
  result: PodOrbstackActionResult
): PodOrbstackActionResult {
  if (result.ok || result.reason || !MISSING_IP.test(result.error)) {
    return result
  }
  return {
    ok: false,
    error: POD_ORBSTACK_OUT_OF_ADDRESSES_MESSAGE,
    reason: 'out-of-addresses',
    detail: result.error
  }
}
