// Fork-only (Pod): app menu items the Pod build profile cuts (src/shared/product/features.ts).
import { POD_FEATURE_PROMOS, POD_TASKS } from '../../shared/product/features'

/** Help menu: the feature tour and setup guide with their separator are promos. */
export function podHelpPromoItems(
  items: Electron.MenuItemConstructorOptions[]
): Electron.MenuItemConstructorOptions[] {
  return POD_FEATURE_PROMOS ? items : []
}

/** View menu: the tasks button toggle belongs to the tasks page cut. */
export function podTasksMenuItem(
  item: Electron.MenuItemConstructorOptions
): Electron.MenuItemConstructorOptions {
  return POD_TASKS ? item : { ...item, visible: false }
}
