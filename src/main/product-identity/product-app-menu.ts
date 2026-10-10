import type { MenuItemConstructorOptions } from 'electron'
import { getProductIdentity } from './product-identity'

/** Settings, then the items a product build adds after it (none for Orca itself). */
export function productMenuItems(
  settingsItem: MenuItemConstructorOptions
): MenuItemConstructorOptions[] {
  const identity = getProductIdentity()
  if (!identity?.legacyProfile) {
    return [settingsItem]
  }
  return [
    settingsItem,
    {
      label: 'Import from Orca…',
      // Why lazy: the action pulls in the daemon provider, which the menu must not load.
      click: () =>
        void import('./legacy-import-action').then(({ importFromLegacyApp }) =>
          importFromLegacyApp(identity)
        )
    }
  ]
}
