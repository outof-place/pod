// Fork-only (Pod): a terminal theme picked over podSettings.set, as the window's picker writes it.
import type { GlobalSettings } from '../../../shared/global-settings-types'

/** A picked dark or light theme replaces the color overrides, or they mask it (TerminalThemeSections.tsx). */
export function clearOverridesOnThemePick(
  update: Partial<GlobalSettings>,
  settings: Pick<GlobalSettings, 'terminalColorOverrides'>
): void {
  const picked = update.terminalThemeDark !== undefined || update.terminalThemeLight !== undefined
  if (picked && Object.keys(settings.terminalColorOverrides ?? {}).length > 0) {
    update.terminalColorOverrides = undefined
  }
}
