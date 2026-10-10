// The native surface holding AppKit's keyboard, per the addon's focus reports. While one does,
// the page is blurred, so a press on DOM UI is what pulls window focus back to it.
let holder: number | null = null
// A keyboard restore not yet confirmed by a focus report; main skips one during a press.
let pendingRestore: number | null = null

export function noteNativeTerminalKeyboard(surfaceId: number, focused: boolean): void {
  if (focused) {
    holder = surfaceId
    if (pendingRestore === surfaceId) {
      pendingRestore = null
    }
  } else if (holder === surfaceId) {
    holder = null
  }
}

export function forgetNativeTerminalKeyboard(surfaceId: number): void {
  noteNativeTerminalKeyboard(surfaceId, false)
  if (pendingRestore === surfaceId) {
    pendingRestore = null
  }
}

export function isNativeTerminalHoldingKeyboard(surfaceId?: number): boolean {
  return surfaceId === undefined ? holder !== null : holder === surfaceId
}

export function notePendingNativeKeyboardRestore(surfaceId: number): void {
  pendingRestore = surfaceId
}

export function takePendingNativeKeyboardRestore(): number | null {
  const surfaceId = pendingRestore
  pendingRestore = null
  return surfaceId
}
