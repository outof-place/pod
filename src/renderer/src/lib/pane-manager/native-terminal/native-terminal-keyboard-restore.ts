import { shouldPreserveEditableFocus } from '@/components/terminal-pane/pane-helpers'
import { isNativeTerminalShown } from './native-terminal-frames'
import {
  isNativeTerminalHoldingKeyboard,
  noteNativeTerminalKeyboard,
  notePendingNativeKeyboardRestore,
  takePendingNativeKeyboardRestore
} from './native-terminal-keyboard'

// Why unlessMousePressed: taking the keyboard mid-press blurs the page and cancels that click
// (tab switches, drags). Main skips the restore then; the release settles it below.
function requestNativeKeyboard(surfaceId: number): void {
  notePendingNativeKeyboardRestore(surfaceId)
  window.api?.nativeTerminal?.focus(surfaceId, { unlessMousePressed: true })
}

// Why: Orca refocuses the active pane on every window focus (wake recovery), which here is
// also the focus a press on page UI causes.
export function focusNativeIfShown(surfaceId: number): boolean {
  if (!isNativeTerminalShown(surfaceId)) {
    return false
  }
  requestNativeKeyboard(surfaceId)
  return true
}

// The click left focus on the pane or on nothing focusable (sidebar background), not on an input,
// a tab rename or the editor.
function clickLeftFocusToPane(surfaceId: number): boolean {
  const active = document.activeElement
  if (active === null || active === document.body) {
    return true
  }
  if (shouldPreserveEditableFocus(active) || document.querySelector('[data-tab-rename-input]')) {
    return false
  }
  return active.closest(`[data-native-surface-id="${surfaceId}"]`) !== null
}

export function installNativeKeyboardRestores(activeShownSurface: () => number | null): void {
  window.api?.nativeTerminal?.onEvent((event) => {
    if (event.kind === 'focus') {
      noteNativeTerminalKeyboard(event.surfaceId, event.focused)
    }
  })
  // Why: Chromium restores focus to the web contents when the window becomes main again.
  window.addEventListener('focus', () => {
    const surfaceId = activeShownSurface()
    if (surfaceId !== null) {
      requestNativeKeyboard(surfaceId)
    }
  })
  const settle = (): void => {
    const surfaceId = takePendingNativeKeyboardRestore()
    if (
      surfaceId !== null &&
      surfaceId === activeShownSurface() &&
      !isNativeTerminalHoldingKeyboard(surfaceId) &&
      clickLeftFocusToPane(surfaceId)
    ) {
      window.api?.nativeTerminal?.focus(surfaceId)
    }
  }
  // Two frames, so the click's own focus (a tab switch, a rename input) lands first.
  window.addEventListener('pointerup', () =>
    requestAnimationFrame(() => requestAnimationFrame(settle))
  )
}
