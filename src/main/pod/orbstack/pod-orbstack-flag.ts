import { getProductIdentity } from '../../product-identity/product-identity'

function hasPodProductIdentity(): boolean {
  try {
    return getProductIdentity() !== null
  } catch {
    // A malformed identity file fails startup elsewhere; it must not also crash a status read.
    return false
  }
}

/** Pod builds on macOS only. `POD_ORBSTACK=0|1` overrides the identity, for tests. */
export function isPodOrbstackEnabled(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  hasIdentity: () => boolean = hasPodProductIdentity
): boolean {
  if (platform !== 'darwin' || env.POD_ORBSTACK === '0') {
    return false
  }
  return env.POD_ORBSTACK === '1' || hasIdentity()
}
