// Main → renderer events from a native terminal surface.
export type NativeTerminalEvent =
  | { surfaceId: number; kind: 'input'; data: string }
  | { surfaceId: number; kind: 'resize'; cols: number; rows: number }
  | { surfaceId: number; kind: 'focus'; focused: boolean }
  | { surfaceId: number; kind: 'title'; title: string }
  | { surfaceId: number; kind: 'openUrl'; url: string }
  | { surfaceId: number; kind: 'bell' }
  // The pointer entered the surface; the page cannot see it under the native view.
  | { surfaceId: number; kind: 'mouseEnter'; buttons: number; windowFocused: boolean }

// [surfaceId, x, y, width, height, visible] in window points (CSS px × zoom factor).
export type NativeTerminalFrame = [number, number, number, number, number, boolean]

export const NATIVE_TERMINAL_EVENT_CHANNEL = 'nativeTerminal:event'
