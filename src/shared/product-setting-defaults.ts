import type { GlobalSettings } from './global-settings-types'

// Fork-only (Pod): defaults a downstream product build changes. Main installs them from the
// product identity before any profile loads; every other process keeps Orca's defaults.
let productDefaults: Partial<GlobalSettings> = {}

export function setProductSettingDefaults(defaults: Partial<GlobalSettings>): void {
  productDefaults = { ...defaults }
}

export function getProductSettingDefaults(): Partial<GlobalSettings> {
  return productDefaults
}
