import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { GlobalSettings } from '../../../shared/global-settings-types'

// The downstream product identity a Pod build ships in Resources (see product/identity.json).
const PRODUCT_IDENTITY_RESOURCE = 'product-identity.json'

let podIdentityPresent: boolean | undefined

function hasPodIdentity(): boolean {
  if (podIdentityPresent === undefined) {
    const resourcesPath: unknown = process.resourcesPath
    podIdentityPresent =
      typeof resourcesPath === 'string' &&
      resourcesPath.length > 0 &&
      existsSync(join(resourcesPath, PRODUCT_IDENTITY_RESOURCE))
  }
  return podIdentityPresent
}

/**
 * Pod builds use the ogd daemon by default; upstream Orca only when the experimental setting is on.
 * `ORCA_POD_SEARCH=0|1` overrides both, for tests and measurements.
 */
export function isPodNativeSearchEnabled(
  settings: Pick<GlobalSettings, 'experimentalPodNativeSearch'>,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform === 'win32' || env.ORCA_POD_SEARCH === '0') {
    return false
  }
  if (env.ORCA_POD_SEARCH === '1' || settings.experimentalPodNativeSearch === true) {
    return true
  }
  return hasPodIdentity()
}
