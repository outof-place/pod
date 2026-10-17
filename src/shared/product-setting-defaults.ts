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

/**
 * One-shot flips a product build makes to a loaded profile. Orca stored `tabAutoGenerateTitle:
 * false` in every profile, so that false is no opt-out until the product has turned it on once.
 */
export function migrateLoadedProductSettings<T extends Partial<GlobalSettings>>(
  settings: T,
  stored: Partial<GlobalSettings> | undefined,
  markNeedsSave: () => void
): T {
  if (
    productDefaults.tabAutoGenerateTitleDefaultedOnForPod !== true ||
    stored?.tabAutoGenerateTitleDefaultedOnForPod === true
  ) {
    return settings
  }
  markNeedsSave()
  return { ...settings, tabAutoGenerateTitle: true, tabAutoGenerateTitleDefaultedOnForPod: true }
}
