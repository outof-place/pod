import type { Terminal } from '@xterm/xterm'
import type { NativeTerminalEvent } from '../../../../../shared/native-terminal-ipc'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { NativeTerminalAppearance } from '../../../../../shared/native-terminal-appearance'
import { getUIZoomFactorForNativeViews, UI_ZOOM_CHANGED_EVENT } from '../../ui-zoom'
import { buildNativeTerminalAppearance } from './native-terminal-appearance'
import {
  isNativeTerminalShown,
  scheduleNativeTerminalFrames,
  trackNativeTerminalFrame
} from './native-terminal-frames'
import { installNativeTerminalMirror, type NativeTerminalMirror } from './native-terminal-mirror'
import {
  createNativeTerminalRenderPause,
  type NativeTerminalRenderPause
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
  onSurfaceAttached: () => void
}

type NativePaneState = {
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

// A pane and the font size its xterm uses (the pane's zoom, else the global setting).
export type NativeTerminalPaneFont = { terminal: Terminal; fontSize: number }

const mirrors = new WeakMap<Terminal, NativeTerminalMirror>()
const states = new WeakMap<Terminal, NativePaneState>()
const terminalsBySurface = new Map<number, Terminal>()
let supported: Promise<boolean> | null = null
let eventsUnsubscribe: (() => void) | null = null
let lastAppearanceKey: string | null = null
let lastAppearance: NativeTerminalAppearance | null = null
let lastSettings: GlobalSettings | null | undefined = null

function nativeTerminalApi(): Window['api']['nativeTerminal'] | null {
  return typeof window === 'undefined' ? null : (window.api?.nativeTerminal ?? null)
}

export function isNativeTerminalRequested(settings: GlobalSettings | null | undefined): boolean {
  return (
    settings?.experimentalNativeTerminal === true &&
    typeof navigator !== 'undefined' &&
    navigator.userAgent.includes('Mac')
  )
}

// Installed for every pane at construction so no byte reaches xterm unseen; it stays
// inert until a surface attaches.
export function installNativeTerminalMirrorForPane(terminal: Terminal): void {
  mirrors.set(
    terminal,
    installNativeTerminalMirror(
      terminal,
      (surfaceId, data) => nativeTerminalApi()?.write(surfaceId, data),
      releaseNativeKeyboard
    )
  )
}

// Why: AppKit keeps the keyboard on a native view until told otherwise, so focusing a pane
// that has no native view on screen (keyboard pane navigation) must hand it to the page.
function releaseNativeKeyboard(): void {
  if (terminalsBySurface.size > 0) {
    nativeTerminalApi()?.releaseKeyboard()
  }
}

export function getNativeTerminalGrid(terminal: Terminal): { cols: number; rows: number } | null {
  const state = states.get(terminal)
  return state?.surfaceId != null ? state.grid : null
}

function handleEvent(event: NativeTerminalEvent): void {
  const terminal = terminalsBySurface.get(event.surfaceId)
  const state = terminal ? states.get(terminal) : undefined
  if (!terminal || !state || state.disposed) {
    return
  }
  switch (event.kind) {
    case 'input':
      state.host.forwardInput(event.data)
      return
    case 'resize':
      state.grid = { cols: event.cols, rows: event.rows }
      // xterm's onResize forwards the grid to the PTY through the usual resize gates.
      if (terminal.cols !== event.cols || terminal.rows !== event.rows) {
        terminal.resize(event.cols, event.rows)
      }
      return
    case 'focus':
      if (event.focused) {
        // Paste/copy listeners resolve their pane from document.activeElement.
        mirrors.get(terminal)?.focusShadow()
        if (!state.host.isActivePane()) {
          state.host.activatePane()
        }
      }
      return
    case 'openUrl':
      if (/^https?:\/\//i.test(event.url)) {
        void window.api.shell.openUrl(event.url)
      }
      break
    case 'mouseEnter':
      // Why the native flag: the page reports unfocused while the native view has the keyboard.
      state.host.followMouseFocus({
        mouseButtons: event.buttons,
        windowHasFocus: event.windowFocused
      })
      break
    case 'title':
    case 'bell':
      // Main's side-effect facts already drive titles and bells from the PTY stream.
      break
  }
}

function ensureGlobalListeners(): void {
  if (eventsUnsubscribe) {
    return
  }
  eventsUnsubscribe = nativeTerminalApi()?.onEvent(handleEvent) ?? null
  // Why: Chromium restores focus to the web contents when the window becomes main again.
  window.addEventListener('focus', () => {
    for (const [surfaceId, terminal] of terminalsBySurface) {
      const state = states.get(terminal)
      if (state?.host.isActivePane() && isNativeTerminalShown(surfaceId)) {
        nativeTerminalApi()?.focus(surfaceId)
        return
      }
    }
  })
  // Ghostty sizes fonts in window points, so a UI zoom needs a config with the new scale.
  window.addEventListener(UI_ZOOM_CHANGED_EVENT, () => {
    if (lastAppearance) {
      sendAppearance(lastAppearance)
    }
    for (const terminal of terminalsBySurface.values()) {
      const state = states.get(terminal)
      if (state?.fontSize != null) {
        sendSurfaceAppearance(terminal, state, state.fontSize)
      }
    }
  })
}

function sendAppearance(appearance: NativeTerminalAppearance): void {
  const zoomFactor = getUIZoomFactorForNativeViews()
  const key = JSON.stringify([appearance, zoomFactor])
  lastAppearance = appearance
  if (key === lastAppearanceKey) {
    return
  }
  lastAppearanceKey = key
  nativeTerminalApi()?.setAppearance(appearance, zoomFactor)
  scheduleNativeTerminalFrames()
}

function surfaceAppearanceKey(appearance: NativeTerminalAppearance, zoomFactor: number): string {
  return JSON.stringify([appearance, zoomFactor])
}

// Ghostty's app config only holds defaults; each surface runs its own config so a pane's
// font zoom reaches its native view.
function sendSurfaceAppearance(terminal: Terminal, state: NativePaneState, fontSize: number): void {
  const api = nativeTerminalApi()
  if (!api || state.surfaceId === null || state.disposed) {
    return
  }
  const appearance = { ...buildNativeTerminalAppearance(terminal.options, lastSettings), fontSize }
  const zoomFactor = getUIZoomFactorForNativeViews()
  const key = surfaceAppearanceKey(appearance, zoomFactor)
  state.fontSize = fontSize
  if (key === state.appearanceKey) {
    return
  }
  state.appearanceKey = key
  api.setSurfaceAppearance(state.surfaceId, appearance, zoomFactor)
  scheduleNativeTerminalFrames()
}

// Per-pane font zoom writes xterm's fontSize directly, outside applyTerminalAppearance.
export function setNativeTerminalFontSize(terminal: Terminal, fontSize: number): void {
  const state = states.get(terminal)
  if (state) {
    sendSurfaceAppearance(terminal, state, fontSize)
  }
}

function focusNativeIfShown(surfaceId: number): boolean {
  if (!isNativeTerminalShown(surfaceId)) {
    return false
  }
  nativeTerminalApi()?.focus(surfaceId)
  return true
}

// Binds (or re-binds) the pane's PTY to a native surface. A rebind to another PTY keeps the
// surface and re-seeds it from the xterm buffer.
export function attachNativeTerminal(
  terminal: Terminal,
  ptyId: string,
  host: NativeTerminalPaneHost,
  settings: GlobalSettings | null | undefined
): void {
  const mirror = mirrors.get(terminal)
  const api = nativeTerminalApi()
  if (!mirror || !api || !isNativeTerminalRequested(settings)) {
    return
  }
  const existing = states.get(terminal)
  if (existing && !existing.disposed) {
    existing.host = host
    if (existing.ptyId !== ptyId) {
      existing.ptyId = ptyId
      mirror.resync()
    }
    return
  }
  const state: NativePaneState = {
    host,
    ptyId,
    surfaceId: null,
    grid: null,
    untrack: null,
    disposed: false,
    renderPause: null,
    fontSize: null,
    appearanceKey: null
  }
  states.set(terminal, state)
  lastSettings = settings
  supported ??= api.isSupported().catch(() => false)
  void (async () => {
    if (!(await supported)) {
      states.delete(terminal)
      return
    }
    const appearance = buildNativeTerminalAppearance(terminal.options, settings)
    lastAppearance = appearance
    const zoomFactor = getUIZoomFactorForNativeViews()
    const surfaceId = await api.create(appearance, zoomFactor).catch(() => null)
    if (surfaceId === null) {
      states.delete(terminal)
      return
    }
    const container = terminal.element?.parentElement
    if (state.disposed || !container) {
      api.destroy(surfaceId)
      return
    }
    ensureGlobalListeners()
    state.surfaceId = surfaceId
    // Lets E2E map each native surface to the pane drawing it.
    container.dataset.nativeSurfaceId = String(surfaceId)
    // Main gives the new surface this appearance as its own config.
    state.fontSize = appearance.fontSize
    state.appearanceKey = surfaceAppearanceKey(appearance, zoomFactor)
    terminalsBySurface.set(surfaceId, terminal)
    mirror.attach(surfaceId, () => state.host.serialize())
    mirror.setFocusTarget(() => focusNativeIfShown(surfaceId))
    const renderPause = createNativeTerminalRenderPause(terminal)
    state.renderPause = renderPause
    state.untrack = trackNativeTerminalFrame(
      {
        surfaceId,
        element: container,
        isShown: () => state.host.isVisible(),
        isDomViewStale: renderPause.isStale,
        onShownChange: (shown) => {
          // Why: xterm needs not paint under a shown native view; it repaints before a hide.
          if (shown) {
            renderPause.pause()
          } else {
            renderPause.resume(scheduleNativeTerminalFrames)
          }
          // Hand the keyboard across whichever view just became visible for the active pane.
          if (!state.host.isActivePane() || !document.hasFocus()) {
            return
          }
          if (shown) {
            api.focus(surfaceId)
          } else {
            mirrors.get(terminal)?.focusShadow()
          }
        }
      },
      (frames) => api.setFrames(frames)
    )
    state.host.onSurfaceAttached()
  })()
}

export function disposeNativeTerminal(terminal: Terminal): void {
  const state = states.get(terminal)
  states.delete(terminal)
  const mirror = mirrors.get(terminal)
  mirrors.delete(terminal)
  mirror?.dispose()
  if (!state) {
    return
  }
  state.disposed = true
  state.untrack?.()
  state.renderPause?.dispose()
  if (state.surfaceId !== null) {
    terminalsBySurface.delete(state.surfaceId)
    terminal.element?.parentElement?.removeAttribute('data-native-surface-id')
    nativeTerminalApi()?.destroy(state.surfaceId)
  }
}

// Ghostty's app config holds the defaults, from the first native pane's resolved xterm options
// at the global font size; every surface then gets its pane's own font size.
export function syncNativeTerminalAppearance(
  panes: readonly NativeTerminalPaneFont[],
  settings: GlobalSettings | null | undefined
): void {
  const api = nativeTerminalApi()
  const native = panes.filter(({ terminal }) => states.get(terminal)?.surfaceId != null)
  const first = native[0]
  if (!api || !first) {
    return
  }
  lastSettings = settings
  sendAppearance({
    ...buildNativeTerminalAppearance(first.terminal.options, settings),
    fontSize: settings?.terminalFontSize ?? first.fontSize
  })
  for (const { terminal, fontSize } of native) {
    setNativeTerminalFontSize(terminal, fontSize)
  }
}
