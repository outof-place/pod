import type { GlobalSettings } from '../../../shared/global-settings-types'
import { getProductIdentity } from '../../product-identity/product-identity'

function hasPodProductIdentity(): boolean {
  try {
    return getProductIdentity() !== null
  } catch {
    // A malformed identity file fails startup elsewhere; it must not also crash a settings read.
    return false
  }
}

/**
 * Pod builds manage the workspace root by default; upstream Orca only when the setting is on.
 * macOS only. `ORCA_POD_WORKSPACE=0|1` overrides both, for tests and measurements.
 */
export function isPodWorkspaceEnabled(
  settings: Pick<GlobalSettings, 'experimentalPodWorkspace'>,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  hasIdentity: () => boolean = hasPodProductIdentity
): boolean {
  if (platform !== 'darwin' || env.ORCA_POD_WORKSPACE === '0') {
    return false
  }
  if (env.ORCA_POD_WORKSPACE === '1' || settings.experimentalPodWorkspace === true) {
    return true
  }
  return hasIdentity()
}
