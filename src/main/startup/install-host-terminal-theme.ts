import { nativeTheme } from 'electron'
import type { GlobalSettings } from '../../shared/global-settings-types'
import {
  setHostSystemPrefersDark,
  settingsUpdateTouchesTerminalTheme
} from '../runtime/runtime-host-terminal-theme'

type HostTerminalThemeStore = {
  onSettingsChanged(listener: (updates: Partial<GlobalSettings>) => void): unknown
}

/** Headless hosts publish Pod's terminal theme themselves, and again when it changes. */
export function installHostTerminalTheme(
  store: HostTerminalThemeStore,
  runtime: { refreshHostTerminalTheme(): void }
): void {
  setHostSystemPrefersDark(() => nativeTheme.shouldUseDarkColors)
  nativeTheme.on('updated', () => runtime.refreshHostTerminalTheme())
  store.onSettingsChanged((updates) => {
    if (settingsUpdateTouchesTerminalTheme(updates)) {
      runtime.refreshHostTerminalTheme()
    }
  })
  runtime.refreshHostTerminalTheme()
}
