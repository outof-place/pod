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

// What the pane's PTY session lends the native view: input forwarding, the visibility
// signal and how to make its pane active.
export type NativeTerminalPaneHost = {
  paneId: number
  serialize: () => string
  isVisible: () => boolean
  forwardInput: (data: string) => void
  activatePane: () => void
  isActivePane: () => boolean
}

type NativePaneState = {
  host: NativeTerminalPaneHost
  ptyId: string
  surfaceId: number | null
  grid: { cols: number; rows: number } | null
  untrack: (() => void) | null
  disposed: boolean
}

const mirrors = new WeakMap<Terminal, NativeTerminalMirror>()
const states = new WeakMap<Terminal, NativePaneState>()
const terminalsBySurface = new Map<number, Terminal>()
let supported: Promise<boolean> | null = null
let eventsUnsubscribe: (() => void) | null = null
let lastAppearanceKey: string | null = null
let lastAppearance: NativeTerminalAppearance | null = null

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
    installNativeTerminalMirror(terminal, (surfaceId, data) =>
      nativeTerminalApi()?.write(surfaceId, data)
    )
  )
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
    disposed: false
  }
  states.set(terminal, state)
  supported ??= api.isSupported().catch(() => false)
  void (async () => {
    if (!(await supported)) {
      states.delete(terminal)
      return
    }
    const appearance = buildNativeTerminalAppearance(terminal.options, settings)
    lastAppearance = appearance
    const surfaceId = await api
      .create(appearance, getUIZoomFactorForNativeViews())
      .catch(() => null)
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
    terminalsBySurface.set(surfaceId, terminal)
    mirror.attach(surfaceId, () => state.host.serialize())
    mirror.setFocusTarget(() => focusNativeIfShown(surfaceId))
    state.untrack = trackNativeTerminalFrame(
      {
        surfaceId,
        element: container,
        isShown: () => state.host.isVisible(),
        onShownChange: (shown) => {
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
  if (state.surfaceId !== null) {
    terminalsBySurface.delete(state.surfaceId)
    nativeTerminalApi()?.destroy(state.surfaceId)
  }
}

// Ghostty's config is app-wide; the first native pane's resolved xterm options stand for all.
export function syncNativeTerminalAppearance(
  terminals: readonly Terminal[],
  settings: GlobalSettings | null | undefined
): void {
  const api = nativeTerminalApi()
  const terminal = terminals.find((candidate) => states.get(candidate)?.surfaceId != null)
  if (!api || !terminal) {
    return
  }
  sendAppearance(buildNativeTerminalAppearance(terminal.options, settings))
}
