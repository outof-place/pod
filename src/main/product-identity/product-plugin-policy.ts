// Fork-only (Pod): main-process side of the third-party plugin policy in shared/product-plugin-policy.
import type { GlobalSettings } from '../../shared/global-settings-types'
import { areThirdPartyPluginsAllowed } from '../../shared/product-plugin-policy'
import { readPluginLockfile } from '../plugins/plugin-install-lockfile-store'
import { areStablyServicesEnabled, productDisplayName } from './product-overlay'

type ReadSettings = () => Pick<GlobalSettings, 'thirdPartyPluginsEnabled'> | null | undefined

let readSettings: ReadSettings = () => null

/** Plugin startup hands over the settings store once; until then a product blocks third parties. */
export function bindThirdPartyPluginSettings(read: ReadSettings): void {
  readSettings = read
}

export function areThirdPartyPluginsAllowedInMain(): boolean {
  return areThirdPartyPluginsAllowed(areStablyServicesEnabled(), readSettings())
}

export function thirdPartyPluginsOffMessage(): string {
  return `Third-party plugins are off in ${productDisplayName()}. Turn them on in Settings > Plugins.`
}

/** Refuses marketplace fetches and installs (every Git checkout and local-path install). */
export function assertThirdPartyPluginsAllowed(): void {
  if (!areThirdPartyPluginsAllowedInMain()) {
    throw new Error(thirdPartyPluginsOffMessage())
  }
}

/** Drops installed plugins the product did not bundle, including unreadable installs. */
export async function withoutBlockedThirdPartyPlugins<T extends { pluginKey?: string }>(
  installed: T[],
  pluginsDir: string
): Promise<T[]> {
  if (areThirdPartyPluginsAllowedInMain()) {
    return installed
  }
  const lock = await readPluginLockfile(pluginsDir)
  return installed.filter(
    (plugin) =>
      plugin.pluginKey !== undefined && lock.plugins[plugin.pluginKey]?.source.kind === 'bundled'
  )
}
