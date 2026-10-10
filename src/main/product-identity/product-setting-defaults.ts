import type { GlobalSettings } from '../../shared/global-settings-types'
import { setProductSettingDefaults } from '../../shared/product-setting-defaults'
import { getProductIdentity, type ProductIdentity } from './product-identity'

// Pod ships the native Ghostty terminal on. A profile without the key (a fresh one, or an Orca
// profile, whose builds never had the setting) takes this default; a stored false stays off.
// Cursor blink defaults off: a blinking focused native pane redraws ~2 frames/s and keeps
// ~230 MB of Metal buffers alive. Only a missing key takes it; a stored true stays on.
export function productSettingDefaults(identity: ProductIdentity | null): Partial<GlobalSettings> {
  return identity ? { experimentalNativeTerminal: true, terminalCursorBlink: false } : {}
}

export function installProductSettingDefaults(): void {
  setProductSettingDefaults(productSettingDefaults(getProductIdentity()))
}
