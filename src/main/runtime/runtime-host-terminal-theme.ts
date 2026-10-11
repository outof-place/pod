import type { RuntimeMobileTerminalTheme } from '../../shared/runtime-mobile-session-tab-contracts'
import type { TerminalOscColorQueryReplyColors } from '../../shared/terminal-osc-color-reply'
import { resolveConfiguredTerminalColors } from '../../shared/terminal-theme-selection'
import {
  resolveRuntimeTerminalTheme,
  RUNTIME_TERMINAL_THEME_SETTING_KEYS,
  type RuntimeTerminalThemeSettings
} from '../../shared/runtime-terminal-theme'

// Why module state (pattern of terminal-view-attribute-store.ts): main installs the appearance
// source once; the runtime reads it whenever it projects a snapshot.
let systemPrefersDark: () => boolean = () => true

export function setHostSystemPrefersDark(read: () => boolean): void {
  systemPrefersDark = read
}

export function hostSystemPrefersDark(): boolean {
  return systemPrefersDark()
}

/** The colours a query gets with no viewer connected: the host's own theme, opaque. */
export function hostViewerColors(
  settings: Partial<RuntimeTerminalThemeSettings> | null | undefined
): TerminalOscColorQueryReplyColors | null {
  return hasThemeSettings(settings)
    ? resolveConfiguredTerminalColors(settings, systemPrefersDark())
    : null
}

function hasThemeSettings(
  settings: Partial<RuntimeTerminalThemeSettings> | null | undefined
): settings is RuntimeTerminalThemeSettings {
  return settings?.theme !== undefined
}

let cached: {
  settings: Partial<RuntimeTerminalThemeSettings>
  prefersDark: boolean
  theme: RuntimeMobileTerminalTheme | undefined
} | null = null

/** The terminal theme this host's settings and appearance resolve to, for tabs no renderer themed. */
export function resolveHostTerminalTheme(
  settings: Partial<RuntimeTerminalThemeSettings> | null | undefined
): RuntimeMobileTerminalTheme | undefined {
  if (!hasThemeSettings(settings)) {
    return undefined
  }
  const prefersDark = systemPrefersDark()
  if (cached?.settings !== settings || cached.prefersDark !== prefersDark) {
    cached = { settings, prefersDark, theme: resolveRuntimeTerminalTheme(settings, prefersDark) }
  }
  return cached.theme
}

export function settingsUpdateTouchesTerminalTheme(updates: object): boolean {
  return RUNTIME_TERMINAL_THEME_SETTING_KEYS.some((key) => key in updates)
}

export function sameTerminalTheme(
  a: RuntimeMobileTerminalTheme | undefined,
  b: RuntimeMobileTerminalTheme | undefined
): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}
