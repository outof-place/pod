import { describe, expect, it } from 'vitest'
import { buildGhosttyConfig } from '../../../../../main/native-terminal/ghostty-native-terminal-config'
import { getDefaultSettings } from '../../../../../shared/constants'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { resolveTerminalFontWeights } from '../../../../../shared/terminal-fonts'
import { resolveTerminalLigaturesEnabled } from '../../../../../shared/terminal-ligatures'
import { buildDefaultTerminalOptions } from '../pane-terminal-options'
import { buildNativeTerminalAppearance } from './native-terminal-appearance'

// Why: xterm and the native Ghostty view draw the same pane, so a font setting must reach both
// the same way. This drives the settings through the xterm option path the pane uses, then into
// the Ghostty config the native view loads.
function bothRenderers(
  settings: Pick<
    GlobalSettings,
    'terminalFontWeight' | 'terminalFontWeightBold' | 'terminalLigatures' | 'terminalFontFamily'
  >
): { xtermLigatures: boolean; ghostty: string } {
  const options = {
    ...buildDefaultTerminalOptions(),
    ...resolveTerminalFontWeights(settings.terminalFontWeight, settings.terminalFontWeightBold)
  }
  const appearance = buildNativeTerminalAppearance(options, {
    ...getDefaultSettings('/home/test'),
    ...settings
  })
  return {
    xtermLigatures: resolveTerminalLigaturesEnabled(
      settings.terminalLigatures,
      settings.terminalFontFamily
    ),
    ghostty: buildGhosttyConfig(appearance, 1)
  }
}

describe('xterm and native Ghostty font parity', () => {
  it.each([
    [300, 'Light'],
    [400, null],
    [500, 'Medium'],
    [600, 'Semibold'],
    [700, 'Bold']
  ])('weight %s draws as %s in both', (weight, style) => {
    const { ghostty } = bothRenderers({
      terminalFontWeight: weight,
      terminalFontWeightBold: 700,
      terminalLigatures: 'off',
      terminalFontFamily: 'SF Mono'
    })
    if (style) {
      expect(ghostty).toContain(`font-style = ${style}\n`)
    } else {
      expect(ghostty).not.toContain('font-style =')
    }
    expect(ghostty).not.toContain('font-style-bold')
  })

  it('carries a non-default bold weight', () => {
    const { ghostty } = bothRenderers({
      terminalFontWeight: 400,
      terminalFontWeightBold: 800,
      terminalLigatures: 'off',
      terminalFontFamily: 'SF Mono'
    })
    expect(ghostty).toContain('font-style-bold = Heavy\n')
  })

  it.each([
    ['off', 'Fira Code'],
    ['on', 'SF Mono'],
    ['auto', 'Fira Code'],
    ['auto', 'SF Mono']
  ] as const)('ligatures %s with %s match xterm', (mode, family) => {
    const { xtermLigatures, ghostty } = bothRenderers({
      terminalFontWeight: 400,
      terminalFontWeightBold: 700,
      terminalLigatures: mode,
      terminalFontFamily: family
    })
    expect(ghostty.includes('font-feature = -calt\n')).toBe(!xtermLigatures)
  })
})
