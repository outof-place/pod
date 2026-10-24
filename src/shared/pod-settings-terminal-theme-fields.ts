// Fork-only (Pod): podSettings' terminal theme rows and the color overrides over them, on their own:
// pod-settings-schema.ts is at its line limit.
import { z } from 'zod'
import { row } from './pod-settings-row'
import { TERMINAL_COLOR_OVERRIDES_FIELD } from './pod-settings-terminal-colors'

export const POD_SETTINGS_TERMINAL_THEME_FIELDS = {
  terminalThemeDark: row(z.string().min(1).max(256), 'Theme'),
  terminalUseSeparateLightTheme: row(z.boolean(), 'Another theme in light mode'),
  terminalThemeLight: row(z.string().min(1).max(256), 'Light theme'),
  terminalColorOverrides: TERMINAL_COLOR_OVERRIDES_FIELD
}
