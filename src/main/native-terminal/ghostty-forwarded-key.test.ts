import { describe, expect, it } from 'vitest'
import { toKeyboardInputEvents } from './ghostty-forwarded-key'

const COMMAND = 1 << 20
const SHIFT = 1 << 17

describe('toKeyboardInputEvents', () => {
  it('replays a command chord as a keyDown/keyUp pair', () => {
    expect(
      toKeyboardInputEvents({
        characters: 't',
        keyCode: 0x11,
        modifierFlags: COMMAND,
        isRepeat: false
      })
    ).toEqual([
      { type: 'keyDown', keyCode: 'T', modifiers: ['meta'] },
      { type: 'keyUp', keyCode: 'T', modifiers: ['meta'] }
    ])
  })

  it('keeps the physical key and reports shift as a modifier', () => {
    const [down] = toKeyboardInputEvents({
      characters: '[',
      keyCode: 0x21,
      modifierFlags: COMMAND | SHIFT,
      isRepeat: false
    })
    expect(down).toEqual({ type: 'keyDown', keyCode: '[', modifiers: ['shift', 'meta'] })
  })

  it('names special keys by their accelerator', () => {
    const [down] = toKeyboardInputEvents({
      characters: '',
      keyCode: 0x7b,
      modifierFlags: COMMAND,
      isRepeat: true
    })
    expect(down).toEqual({ type: 'keyDown', keyCode: 'Left', modifiers: ['meta', 'isautorepeat'] })
  })

  it('drops events with no usable key', () => {
    expect(
      toKeyboardInputEvents({
        characters: '',
        keyCode: 0x3f,
        modifierFlags: COMMAND,
        isRepeat: false
      })
    ).toEqual([])
  })
})
