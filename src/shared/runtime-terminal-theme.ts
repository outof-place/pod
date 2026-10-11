import type { GlobalSettings } from './global-settings-types'
import type { RuntimeMobileTerminalTheme } from './runtime-mobile-session-tab-contracts'
import { normalizeTerminalMinimumContrastRatio } from './terminal-minimum-contrast-settings'
import {
  resolveSelectedTerminalTheme,
  type TerminalThemeSelectionSettings
} from './terminal-theme-selection'

export type RuntimeTerminalThemeSettings = TerminalThemeSelectionSettings &
  Pick<
    GlobalSettings,
    | 'terminalCustomThemes'
    | 'terminalColorOverrides'
    | 'terminalBackgroundOpacity'
    | 'terminalCursorOpacity'
    | 'terminalMinimumContrastRatio'
  >

/** Every setting the published terminal theme reads; a change to any of them republishes it. */
export const RUNTIME_TERMINAL_THEME_SETTING_KEYS = [
  'theme',
  'terminalThemeDark',
  'terminalUseSeparateLightTheme',
  'terminalThemeLight',
  'terminalCustomThemes',
  'terminalColorOverrides',
  'terminalBackgroundOpacity',
  'terminalCursorOpacity',
  'terminalMinimumContrastRatio'
] as const satisfies readonly (keyof RuntimeTerminalThemeSettings)[]

function hexToRgba(hex: string, alpha: number): string {
  let clean = hex.replace('#', '')
  if (clean.length === 3) {
    clean = clean
      .split('')
      .map((character) => character + character)
      .join('')
  }
  const r = Number.parseInt(clean.slice(0, 2), 16)
  const g = Number.parseInt(clean.slice(2, 4), 16)
  const b = Number.parseInt(clean.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function isHexColor(value: string | undefined): value is string {
  return typeof value === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value)
}

/**
 * The terminal theme a session snapshot carries to its clients: the selected theme with the user's
 * overrides and opacities, and an explicit contrast floor. One rule for the renderer's graph and a
 * headless host, which has no renderer to publish it.
 */
export function resolveRuntimeTerminalTheme(
  settings: RuntimeTerminalThemeSettings,
  systemPrefersDark: boolean
): RuntimeMobileTerminalTheme | undefined {
  const { mode, theme: selected } = resolveSelectedTerminalTheme(settings, systemPrefersDark)
  const resolvedTheme = selected ? { ...selected, ...settings.terminalColorOverrides } : undefined
  if (!resolvedTheme) {
    return undefined
  }
  if (settings.terminalBackgroundOpacity !== undefined && isHexColor(resolvedTheme.background)) {
    resolvedTheme.background = hexToRgba(
      resolvedTheme.background,
      settings.terminalBackgroundOpacity
    )
  }
  if (settings.terminalCursorOpacity !== undefined && isHexColor(resolvedTheme.cursor)) {
    resolvedTheme.cursor = hexToRgba(resolvedTheme.cursor, settings.terminalCursorOpacity)
  }

  const theme: Record<string, string> = {}
  for (const [key, value] of Object.entries(resolvedTheme)) {
    if (typeof value === 'string') {
      theme[key] = value
    }
  }
  return {
    mode,
    theme,
    // Why publish: mobile mirrors the desktop contrast gate, so an explicit floor has to travel with
    // the theme or the same session would render differently on the phone (#10754).
    minimumContrastRatio: normalizeTerminalMinimumContrastRatio(
      settings.terminalMinimumContrastRatio
    )
  }
}
