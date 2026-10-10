import { isNativeTerminalShown } from './native-terminal-frames'

// The native surface holding AppKit's keyboard, per the addon's focus reports. While one does,
// the page is blurred, so a press on DOM UI is what pulls window focus back to it.
let holder: number | null = null

export function noteNativeTerminalKeyboard(surfaceId: number, focused: boolean): void {
  if (focused) {
    holder = surfaceId
  } else if (holder === surfaceId) {
    holder = null
  }
}

export function isNativeTerminalHoldingKeyboard(): boolean {
  return holder !== null
}

// Why: Chromium restores focus to the web contents when the window becomes main again. A press
// on page UI focuses the page too, and taking the keyboard back mid-press would cancel that click.
export function restoreNativeKeyboardOnWindowFocus(activeShownSurface: () => number | null): void {
  window.addEventListener('focus', () => {
    const surfaceId = activeShownSurface()
    if (surfaceId !== null) {
      window.api?.nativeTerminal?.focus(surfaceId, { unlessMousePressed: true })
    }
  })
}

export function focusNativeIfShown(surfaceId: number): boolean {
  if (!isNativeTerminalShown(surfaceId)) {
    return false
  }
  // Why: Orca refocuses the active pane on every window focus (wake recovery), which here is
  // also the focus a press on page UI causes; that press decides where the keyboard goes.
  window.api?.nativeTerminal?.focus(surfaceId, { unlessMousePressed: true })
  return true
}
