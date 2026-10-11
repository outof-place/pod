import { describe, expect, it } from 'vitest'
import { resolveRuntimeTerminalTheme } from './runtime-terminal-theme'
import { resolveSelectedTerminalTheme } from './terminal-theme-selection'

const base = {
  theme: 'system' as const,
  terminalThemeDark: '',
  terminalUseSeparateLightTheme: true,
  terminalThemeLight: ''
}

describe('resolveRuntimeTerminalTheme', () => {
  it('picks the light or dark variant from the appearance', () => {
    expect(resolveRuntimeTerminalTheme(base, true)?.mode).toBe('dark')
    expect(resolveRuntimeTerminalTheme(base, false)?.mode).toBe('light')
    expect(resolveRuntimeTerminalTheme({ ...base, theme: 'light' }, true)?.mode).toBe('light')
  })

  it('falls back to the mode default for an unknown theme name', () => {
    const selected = resolveSelectedTerminalTheme(
      { ...base, terminalThemeDark: 'No Such Theme' },
      true
    )
    expect(selected.themeName).toBe('No Such Theme')
    expect(selected.theme?.background).toBe('#282c34')
  })

  it('applies overrides, opacities and the contrast floor', () => {
    const theme = resolveRuntimeTerminalTheme(
      {
        ...base,
        terminalColorOverrides: { foreground: '#abcdef' },
        terminalBackgroundOpacity: 0.5,
        terminalMinimumContrastRatio: 40
      },
      true
    )
    expect(theme?.theme.foreground).toBe('#abcdef')
    expect(theme?.theme.background).toBe('rgba(40, 44, 52, 0.5)')
    expect(theme?.minimumContrastRatio).toBe(21)
  })
})
