// @vitest-environment happy-dom

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { NativeTerminalEvent } from '../../../../../shared/native-terminal-ipc'
import { forgetNativeTerminalKeyboard } from './native-terminal-keyboard'
import { installNativeKeyboardRestores } from './native-terminal-keyboard-restore'

vi.mock('./native-terminal-frames', () => ({ isNativeTerminalShown: () => true }))

const SURFACE = 7
const focus = vi.fn()
let emit: (event: NativeTerminalEvent) => void = () => undefined
let activeSurface: number | null = SURFACE

beforeAll(() => {
  Reflect.set(window, 'api', {
    nativeTerminal: {
      focus,
      onEvent: (callback: (event: NativeTerminalEvent) => void) => {
        emit = callback
        return () => undefined
      }
    }
  })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 0
  })
  installNativeKeyboardRestores(() => activeSurface)
})

afterEach(() => {
  forgetNativeTerminalKeyboard(SURFACE)
  focus.mockClear()
  activeSurface = SURFACE
  document.body.replaceChildren()
})

// A press on page UI: the page focus asks for the keyboard back, main skips it, then the release.
function pressOnPage(target?: HTMLElement): void {
  window.dispatchEvent(new Event('focus'))
  target?.focus()
  window.dispatchEvent(new Event('pointerup'))
}

describe('installNativeKeyboardRestores', () => {
  it('gives the keyboard back once a click leaves focus on nothing focusable', () => {
    pressOnPage()

    expect(focus.mock.calls).toEqual([[SURFACE, { unlessMousePressed: true }], [SURFACE]])
  })

  it('keeps the keyboard in the page when the click focused an input', () => {
    const input = document.createElement('input')
    document.body.append(input)
    pressOnPage(input)

    expect(focus.mock.calls).toEqual([[SURFACE, { unlessMousePressed: true }]])
  })

  it('does not repeat a restore main already applied', () => {
    window.dispatchEvent(new Event('focus'))
    emit({ kind: 'focus', surfaceId: SURFACE, focused: true })
    window.dispatchEvent(new Event('pointerup'))

    expect(focus).toHaveBeenCalledTimes(1)
  })

  it('drops the restore when the click moved off that pane (a tab switch)', () => {
    window.dispatchEvent(new Event('focus'))
    activeSurface = null
    window.dispatchEvent(new Event('pointerup'))

    expect(focus).toHaveBeenCalledTimes(1)
  })
})
