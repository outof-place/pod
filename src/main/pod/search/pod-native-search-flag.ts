import type { GlobalSettings } from '../../../shared/global-settings-types'

/**
 * Pod's one switch for indexed search (Settings: Indexed search): quick open and text search ask
 * ogd, and agents started in new terminals get og as their rg (POD_INDEXED_SEARCH, read by Pod's
 * agent launcher). Off unless the user turned it on; while off nothing connects to ogd or registers
 * a root. `ORCA_POD_SEARCH=0|1` overrides the setting, for tests and measurements.
 */
export function isPodNativeSearchEnabled(
  settings: Pick<GlobalSettings, 'experimentalPodNativeSearch'>,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform === 'win32' || env.ORCA_POD_SEARCH === '0') {
    return false
  }
  return env.ORCA_POD_SEARCH === '1' || settings.experimentalPodNativeSearch === true
}
