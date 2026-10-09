import type { GlobalSettings } from './global-settings-types'

// Fork-only (Pod): without Stably's plugin kill list nothing can revoke a bad third-party plugin
// remotely, so a product without Stably's services runs only the plugins it bundles until the
// user opts in. Upstream Orca (stablyServices) is always allowed.
export function areThirdPartyPluginsAllowed(
  stablyServices: boolean,
  settings: Pick<GlobalSettings, 'thirdPartyPluginsEnabled'> | null | undefined
): boolean {
  return stablyServices || settings?.thirdPartyPluginsEnabled === true
}
