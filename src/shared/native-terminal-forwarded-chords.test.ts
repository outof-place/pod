import { describe, expect, it } from 'vitest'
import {
  buildNativeTerminalForwardedChords,
  isNativeTerminalForwardedChord,
  type NativeTerminalForwardedChord
} from './native-terminal-forwarded-chords'
import { NS_CONTROL, NS_OPTION, NS_SHIFT } from './native-terminal-keys'

const TAB = 0x30
const PAGE_UP = 0x74
const PAGE_DOWN = 0x79
const LEFT = 0x7b

function named(keyCode: number, modifierFlags: number): NativeTerminalForwardedChord {
  return { keyCode, character: '', modifierFlags }
}

function character(value: string, modifierFlags: number): NativeTerminalForwardedChord {
  return { keyCode: -1, character: value, modifierFlags }
}

describe('buildNativeTerminalForwardedChords', () => {
  it('claims the default Ctrl tab chords, the switcher reverse and every tab index', () => {
    const chords = buildNativeTerminalForwardedChords({
      overrides: undefined,
      terminalShortcutPolicy: 'orca-first'
    })
    expect(chords).toEqual(
      expect.arrayContaining([
        named(TAB, NS_CONTROL),
        named(TAB, NS_CONTROL | NS_SHIFT),
        named(PAGE_DOWN, NS_CONTROL),
        named(PAGE_UP, NS_CONTROL),
        ...['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) =>
          character(digit, NS_CONTROL)
        )
      ])
    )
  })

  it('leaves Command chords, editor-only chords and plain typing to their existing paths', () => {
    const chords = buildNativeTerminalForwardedChords({
      overrides: undefined,
      terminalShortcutPolicy: 'orca-first'
    })
    // Alt+Z is editor.toggleWordWrap, F7 editor.nextChange: neither runs over a terminal.
    expect(chords).not.toContainEqual(character('z', NS_OPTION))
    expect(chords.some((chord) => chord.keyCode === 0x62)).toBe(false)
    expect(chords.every((chord) => chord.modifierFlags !== 0)).toBe(true)
  })

  it('yields chords the terminal-first policy hands back to the terminal', () => {
    const chords = buildNativeTerminalForwardedChords({
      overrides: undefined,
      terminalShortcutPolicy: 'terminal-first'
    })
    expect(chords).toContainEqual(named(TAB, NS_CONTROL))
    expect(chords).not.toContainEqual(character('1', NS_CONTROL))
  })

  it('follows user bindings, including removed defaults', () => {
    const chords = buildNativeTerminalForwardedChords({
      overrides: {
        'terminal.focusPreviousPane': ['Ctrl+Alt+H'],
        'terminal.focusNextPane': ['Ctrl+Alt+ArrowLeft', 'Ctrl+Alt+BracketRight'],
        'tab.nextTerminal': []
      },
      terminalShortcutPolicy: 'orca-first'
    })
    expect(chords).toEqual(
      expect.arrayContaining([
        character('h', NS_CONTROL | NS_OPTION),
        named(LEFT, NS_CONTROL | NS_OPTION),
        character(']', NS_CONTROL | NS_OPTION)
      ])
    )
    expect(chords).not.toContainEqual(named(PAGE_DOWN, NS_CONTROL))
  })

  it('skips double-tap bindings, which carry no key for the native view to match', () => {
    const chords = buildNativeTerminalForwardedChords({
      overrides: { 'terminal.focusNextPane': ['DoubleTap+Shift'] },
      terminalShortcutPolicy: 'orca-first'
    })
    expect(chords.every((chord) => chord.character !== '' || chord.keyCode >= 0)).toBe(true)
    expect(chords).not.toContainEqual(expect.objectContaining({ modifierFlags: NS_SHIFT }))
  })
})

describe('isNativeTerminalForwardedChord', () => {
  it('accepts the IPC shape and rejects anything else', () => {
    expect(isNativeTerminalForwardedChord(named(TAB, NS_CONTROL))).toBe(true)
    expect(isNativeTerminalForwardedChord(character('h', NS_CONTROL))).toBe(true)
    expect(isNativeTerminalForwardedChord({ keyCode: 1.5, character: '', modifierFlags: 0 })).toBe(
      false
    )
    expect(isNativeTerminalForwardedChord({ keyCode: 1, character: 'ab', modifierFlags: 0 })).toBe(
      false
    )
    expect(isNativeTerminalForwardedChord(null)).toBe(false)
  })
})
