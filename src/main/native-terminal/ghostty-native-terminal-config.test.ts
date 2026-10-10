import { describe, expect, it } from 'vitest'
import type { NativeTerminalAppearance } from '../../shared/native-terminal-appearance'
import {
  buildGhosttyConfig,
  toGhosttyColor,
  toGhosttyFontFamilies,
  toGhosttyFontStyle
} from './ghostty-native-terminal-config'

const appearance: NativeTerminalAppearance = {
  fontFamily: '"SF Mono", Menlo, ui-monospace, monospace',
  fontSize: 13,
  lineHeight: 1.2,
  letterSpacing: 0,
  cursorStyle: 'bar',
  cursorBlink: false,
  scrollback: 10000,
  macOptionAsAlt: 'left',
  drawBoldTextInBrightColors: true,
  minimumContrastRatio: 1,
  mouseHideWhileTyping: true,
  copyOnSelect: false,
  paddingX: 8,
  paddingY: 4,
  theme: {
    background: '#101014',
    foreground: 'rgb(230, 230, 230)',
    red: '#f00',
    brightWhite: '#ffffffcc'
  }
}

describe('toGhosttyColor', () => {
  it('normalizes hex and rgb forms to opaque #rrggbb', () => {
    expect(toGhosttyColor('#ABC')).toBe('#aabbcc')
    expect(toGhosttyColor('#11223344')).toBe('#112233')
    expect(toGhosttyColor('rgba(255, 0, 128, 0.5)')).toBe('#ff0080')
  })

  it('rejects values Ghostty cannot parse', () => {
    expect(toGhosttyColor('transparent')).toBeNull()
    expect(toGhosttyColor('#12345')).toBeNull()
    expect(toGhosttyColor(undefined)).toBeNull()
  })
})

describe('toGhosttyFontFamilies', () => {
  it('keeps named families in order and drops CSS generics', () => {
    expect(toGhosttyFontFamilies(appearance.fontFamily)).toEqual(['SF Mono', 'Menlo'])
  })
})

describe('buildGhosttyConfig', () => {
  it('maps xterm appearance to Ghostty keys', () => {
    const config = buildGhosttyConfig(appearance, 1)
    expect(config).toContain('font-family = \nfont-family = SF Mono\nfont-family = Menlo\n')
    expect(config).toContain('font-size = 13\n')
    expect(config).toContain('adjust-cell-height = 20%\n')
    expect(config).toContain('cursor-style = bar\n')
    expect(config).toContain('cursor-style-blink = false\n')
    expect(config).toContain('macos-option-as-alt = left\n')
    expect(config).toContain('scrollback-limit = 10240000\n')
    expect(config).toContain('background = #101014\n')
    expect(config).toContain('foreground = #e6e6e6\n')
    expect(config).toContain('palette = 1=#ff0000\n')
    expect(config).toContain('palette = 15=#ffffff\n')
  })

  it('follows the terminal weight and ligature settings', () => {
    const regular = buildGhosttyConfig(appearance, 1)
    expect(regular).toContain('font-feature = -calt\nfont-feature = -liga\nfont-feature = -dlig\n')
    expect(regular).not.toContain('font-style')
    const medium = buildGhosttyConfig(
      { ...appearance, fontWeight: 500, fontWeightBold: 'bold', ligatures: true },
      1
    )
    expect(medium).toContain('font-style = Medium\n')
    expect(medium).not.toContain('font-style-bold')
    expect(medium).not.toContain('font-feature')
    expect(buildGhosttyConfig({ ...appearance, fontWeightBold: 800 }, 1)).toContain(
      'font-style-bold = Heavy\n'
    )
  })

  it('maps CSS weights to the style names Ghostty matches', () => {
    expect(toGhosttyFontStyle('normal', 400)).toBeNull()
    expect(toGhosttyFontStyle(450, 400)).toBe('Medium')
    expect(toGhosttyFontStyle('300', 400)).toBe('Light')
    expect(toGhosttyFontStyle('bold', 700)).toBeNull()
    expect(toGhosttyFontStyle(600, 700)).toBe('Semibold')
    expect(toGhosttyFontStyle('heavy', 400)).toBeNull()
    expect(toGhosttyFontStyle(undefined, 400)).toBeNull()
  })

  it('keeps Ghostty from owning keybindings, the clipboard protocol and padding', () => {
    const config = buildGhosttyConfig(appearance, 1)
    for (const line of ['keybind = clear', 'clipboard-read = deny', 'clipboard-write = deny']) {
      expect(config).toContain(`${line}\n`)
    }
  })

  it('cannot be made to append config lines from renderer-supplied values', () => {
    const hostile = Object.assign({}, appearance, {
      fontFamily: 'Menlo\nkeybind = super+q=quit',
      cursorStyle: 'beam\nx'
    })
    const config = buildGhosttyConfig(hostile, 1)
    expect(config).not.toContain('\nkeybind = super+q')
    expect(config).toContain('cursor-style = block\n')
  })

  it('scales the font and padding with the window zoom so cells match the DOM pane', () => {
    const config = buildGhosttyConfig(appearance, 1.25)
    expect(config).toContain('font-size = 16.25\n')
    expect(config).toContain('window-padding-x = 10\n')
    expect(config).toContain('window-padding-y = 5\n')
  })
})
