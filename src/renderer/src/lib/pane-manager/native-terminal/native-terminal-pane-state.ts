import type {
  NativeTerminalRenderPause,
  NativeTerminalXtermFeed
} from './native-terminal-render-pause'

// What the pane's PTY session lends the native view: input forwarding, the visibility
// signal and how to make its pane active.
export type NativeTerminalPaneHost = {
  paneId: number
  serialize: () => string
  isVisible: () => boolean
  forwardInput: (data: string) => void
  activatePane: () => void
  isActivePane: () => boolean
  // Focus-follows-mouse for pointer entry the pane's DOM never sees under the native view.
  followMouseFocus: (pointer: { mouseButtons: number; windowHasFocus: boolean }) => void
  // The surface is bound to `ptyId`, first or after a rebind.
  onSurfaceBound: (surfaceId: number, ptyId: string) => void
  // Text the surface was handed to paste (Services menu).
  pasteText: (text: string) => void
  // Parse once: lets xterm leave the byte stream while main feeds the covering native view.
  xtermFeed?: NativeTerminalXtermFeed
}

export type NativePaneState = {
  host: NativeTerminalPaneHost
  ptyId: string
  surfaceId: number | null
  grid: { cols: number; rows: number } | null
  untrack: (() => void) | null
  disposed: boolean
  renderPause: NativeTerminalRenderPause | null
  // This pane's font size (per-pane zoom) and the surface config last sent for it.
  fontSize: number | null
  appearanceKey: string | null
}
