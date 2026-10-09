import type { KeyboardInputEvent } from 'electron'

// NSEventModifierFlags bits (AppKit).
const NS_SHIFT = 1 << 17
const NS_CONTROL = 1 << 18
const NS_OPTION = 1 << 19
const NS_COMMAND = 1 << 20

// macOS virtual key codes (Carbon kVK_*) for keys whose characters are not their accelerator name.
const SPECIAL_KEYS: Readonly<Record<number, string>> = {
  0x24: 'Enter',
  0x4c: 'Enter',
  0x30: 'Tab',
  0x31: 'Space',
  0x33: 'Backspace',
  0x35: 'Escape',
  0x75: 'Delete',
  0x73: 'Home',
  0x77: 'End',
  0x74: 'PageUp',
  0x79: 'PageDown',
  0x7b: 'Left',
  0x7c: 'Right',
  0x7d: 'Down',
  0x7e: 'Up',
  0x7a: 'F1',
  0x78: 'F2',
  0x63: 'F3',
  0x76: 'F4',
  0x60: 'F5',
  0x61: 'F6',
  0x62: 'F7',
  0x64: 'F8',
  0x65: 'F9',
  0x6d: 'F10',
  0x67: 'F11',
  0x6f: 'F12'
}

export type ForwardedNativeKey = {
  characters: string
  keyCode: number
  modifierFlags: number
  isRepeat: boolean
}

// A chord the native terminal handed back to Orca, replayed into the renderer as real input.
export function toKeyboardInputEvents(key: ForwardedNativeKey): KeyboardInputEvent[] {
  const keyCode = SPECIAL_KEYS[key.keyCode] ?? key.characters.slice(0, 1).toUpperCase()
  if (!keyCode) {
    return []
  }
  const modifiers: KeyboardInputEvent['modifiers'] = []
  if (key.modifierFlags & NS_SHIFT) {
    modifiers.push('shift')
  }
  if (key.modifierFlags & NS_CONTROL) {
    modifiers.push('control')
  }
  if (key.modifierFlags & NS_OPTION) {
    modifiers.push('alt')
  }
  if (key.modifierFlags & NS_COMMAND) {
    modifiers.push('meta')
  }
  const downModifiers: KeyboardInputEvent['modifiers'] = key.isRepeat
    ? [...modifiers, 'isautorepeat']
    : modifiers
  return [
    { type: 'keyDown', keyCode, modifiers: downModifiers },
    { type: 'keyUp', keyCode, modifiers }
  ]
}
