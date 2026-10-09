import type { GlobalSettings } from '../../shared/global-settings-types'
import { setProductSettingDefaults } from '../../shared/product-setting-defaults'
import { getProductIdentity, type ProductIdentity } from './product-identity'

// Pod ships the native Ghostty terminal on. A profile without the key (a fresh one, or an Orca
// profile, whose builds never had the setting) takes this default; a stored false stays off.
export function productSettingDefaults(identity: ProductIdentity | null): Partial<GlobalSettings> {
  return identity ? { experimentalNativeTerminal: true } : {}
}

export function installProductSettingDefaults(): void {
  setProductSettingDefaults(productSettingDefaults(getProductIdentity()))
}
