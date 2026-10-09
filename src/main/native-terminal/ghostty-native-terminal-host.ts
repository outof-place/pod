import { app, BrowserWindow, type WebContents } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeTerminalAppearance } from '../../shared/native-terminal-appearance'
import {
  NATIVE_TERMINAL_EVENT_CHANNEL,
  type NativeTerminalEvent,
  type NativeTerminalFrame
} from '../../shared/native-terminal-ipc'
import {
  loadGhosttyTerminalAddon,
  type GhosttyTerminalAddon
} from './ghostty-native-terminal-addon'
import { buildGhosttyConfig } from './ghostty-native-terminal-config'
import { toKeyboardInputEvents } from './ghostty-forwarded-key'

type SurfaceOwner = { webContents: WebContents; window: BrowserWindow }

const owners = new Map<number, SurfaceOwner>()
// The surface that is AppKit's first responder right now, per window.
const firstResponderByWindow = new Map<number, number>()
const trackedWindows = new WeakSet<BrowserWindow>()
let addon: GhosttyTerminalAddon | null = null
let initialized = false
let lastConfigText: string | null = null

function configPath(): string {
  const dir = join(app.getPath('userData'), 'native-terminal')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'ghostty.conf')
}

function writeConfig(appearance: NativeTerminalAppearance, zoomFactor: number): string | null {
  const text = buildGhosttyConfig(appearance, zoomFactor)
  if (text === lastConfigText) {
    return null
  }
  lastConfigText = text
  const path = configPath()
  writeFileSync(path, text)
  return path
}

function ensureInitialized(
  appearance: NativeTerminalAppearance,
  zoomFactor: number
): GhosttyTerminalAddon | null {
  if (initialized) {
    return addon
  }
  addon = loadGhosttyTerminalAddon()
  if (!addon) {
    return null
  }
  const path = writeConfig(appearance, zoomFactor) ?? configPath()
  if (!addon.init(path)) {
    console.error('[native-terminal] Ghostty failed to initialize')
    addon = null
    return null
  }
  initialized = true
  app.on('did-become-active', () => addon?.setAppFocus(true))
  app.on('did-resign-active', () => addon?.setAppFocus(false))
  return addon
}

function sendEvent(owner: SurfaceOwner, event: NativeTerminalEvent): void {
  if (!owner.webContents.isDestroyed()) {
    owner.webContents.send(NATIVE_TERMINAL_EVENT_CHANNEL, event)
  }
}

function trackWindow(window: BrowserWindow, webContents: WebContents): void {
  if (trackedWindows.has(window)) {
    return
  }
  trackedWindows.add(window)
  // Surfaces live in this window's view tree; a reload or crash drops their renderer owner.
  const destroyAll = (): void => {
    for (const [surfaceId, owner] of owners) {
      if (owner.window === window) {
        destroySurface(surfaceId)
      }
    }
  }
  webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) {
      destroyAll()
    }
  })
  webContents.on('render-process-gone', destroyAll)
  window.on('closed', destroyAll)
}

function handleSurfaceEvent(surfaceId: number, kind: string, args: unknown[]): void {
  const owner = owners.get(surfaceId)
  if (!owner) {
    return
  }
  switch (kind) {
    case 'input':
      if (Buffer.isBuffer(args[0])) {
        sendEvent(owner, { surfaceId, kind: 'input', data: args[0].toString('utf8') })
      }
      return
    case 'resize':
      sendEvent(owner, { surfaceId, kind: 'resize', cols: Number(args[0]), rows: Number(args[1]) })
      return
    case 'focus': {
      const focused = args[0] === true
      if (focused) {
        firstResponderByWindow.set(owner.window.id, surfaceId)
      } else if (firstResponderByWindow.get(owner.window.id) === surfaceId) {
        firstResponderByWindow.delete(owner.window.id)
      }
      sendEvent(owner, { surfaceId, kind: 'focus', focused })
      return
    }
    case 'key':
      for (const input of toKeyboardInputEvents({
        characters: String(args[0] ?? ''),
        keyCode: Number(args[1]),
        modifierFlags: Number(args[2]),
        isRepeat: args[3] === true
      })) {
        owner.webContents.sendInputEvent(input)
      }
      return
    case 'contextMenu': {
      // Replay as a right click at the same window point so the pane's DOM context menu opens.
      const x = Math.round(Number(args[0]))
      const y = Math.round(Number(args[1]))
      owner.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'right', clickCount: 1 })
      owner.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'right', clickCount: 1 })
      return
    }
    case 'title':
      sendEvent(owner, { surfaceId, kind: 'title', title: String(args[0] ?? '') })
      return
    case 'openUrl':
      sendEvent(owner, { surfaceId, kind: 'openUrl', url: String(args[0] ?? '') })
      return
    case 'bell':
      sendEvent(owner, { surfaceId, kind: 'bell' })
      break
    default:
      break
  }
}

export function isNativeTerminalSupported(): boolean {
  return process.platform === 'darwin' && loadGhosttyTerminalAddon() !== null
}

export function createSurface(
  webContents: WebContents,
  appearance: NativeTerminalAppearance,
  zoomFactor: number
): number | null {
  const window = BrowserWindow.fromWebContents(webContents)
  if (!window || window.isDestroyed()) {
    return null
  }
  const native = ensureInitialized(appearance, zoomFactor)
  if (!native) {
    return null
  }
  const path = writeConfig(appearance, zoomFactor)
  if (path) {
    native.updateConfig(path)
  }
  trackWindow(window, webContents)
  // Created hidden at zero size; the renderer's first frame report places it.
  const surfaceId = native.createSurface(
    window.getNativeWindowHandle(),
    0,
    0,
    1,
    1,
    (kind, ...args) => handleSurfaceEvent(surfaceId, kind, args)
  )
  owners.set(surfaceId, { webContents, window })
  native.setFrames([[surfaceId, 0, 0, 1, 1, false]])
  return surfaceId
}

function ownedBy(surfaceId: number, webContents: WebContents): boolean {
  return owners.get(surfaceId)?.webContents === webContents
}

export function writeSurfaceOutput(
  webContents: WebContents,
  surfaceId: number,
  data: string
): void {
  if (addon && ownedBy(surfaceId, webContents)) {
    addon.writeOutput(surfaceId, Buffer.from(data, 'utf8'))
  }
}

export function setSurfaceFrames(webContents: WebContents, frames: NativeTerminalFrame[]): void {
  if (addon) {
    addon.setFrames(frames.filter(([surfaceId]) => ownedBy(surfaceId, webContents)))
  }
}

export function focusSurface(webContents: WebContents, surfaceId: number): void {
  if (addon && ownedBy(surfaceId, webContents)) {
    addon.focus(surfaceId)
  }
}

export function readSurfaceSelection(webContents: WebContents, surfaceId: number): string | null {
  return addon && ownedBy(surfaceId, webContents) ? addon.readSelection(surfaceId) : null
}

const MENU_ACTIONS = {
  copy: 'copy_to_clipboard',
  'select-all': 'select_all'
} as const

// Edit-menu copy/select-all while a native surface has the keyboard: the selection lives in
// Ghostty, not in the hidden xterm the renderer would read.
export function performNativeTerminalMenuAction(
  window: BrowserWindow,
  action: keyof typeof MENU_ACTIONS
): boolean {
  const surfaceId = firstResponderByWindow.get(window.id)
  if (!addon || surfaceId === undefined || !owners.has(surfaceId)) {
    return false
  }
  addon.performAction(surfaceId, MENU_ACTIONS[action])
  return true
}

export function updateAppearance(appearance: NativeTerminalAppearance, zoomFactor: number): void {
  if (!addon) {
    return
  }
  const path = writeConfig(appearance, zoomFactor)
  if (path) {
    addon.updateConfig(path)
  }
}

export function destroySurface(surfaceId: number): void {
  const owner = owners.get(surfaceId)
  if (!owner) {
    return
  }
  owners.delete(surfaceId)
  if (firstResponderByWindow.get(owner.window.id) === surfaceId) {
    firstResponderByWindow.delete(owner.window.id)
  }
  addon?.destroySurface(surfaceId)
}

// Unpackaged builds only: lets E2E drive and inspect surfaces through electronApp.evaluate.
export function installNativeTerminalDebugHooks(): void {
  if (app.isPackaged) {
    return
  }
  Object.assign(globalThis, {
    __orcaNativeTerminalDebug: {
      surfaceIds: (): number[] => [...owners.keys()],
      state: (surfaceId: number) => addon?.debugState(surfaceId) ?? null,
      grid: (surfaceId: number) => addon?.gridSize(surfaceId) ?? null,
      screenText: (surfaceId: number) => addon?.debugScreenText(surfaceId) ?? null,
      snapshotBase64: (surfaceId: number) =>
        addon?.debugSnapshot(surfaceId)?.toString('base64') ?? null,
      key: (surfaceId: number, characters: string, keyCode: number, modifierFlags = 0) =>
        addon?.debugKey(surfaceId, characters, keyCode, modifierFlags),
      scrollbar: (surfaceId: number) => addon?.debugState(surfaceId)?.scrollbar ?? null,
      scrollbarScroll: (surfaceId: number, fraction: number) =>
        addon?.debugScrollbarScroll(surfaceId, fraction) ?? false
    }
  })
}

export function destroyOwnedSurface(webContents: WebContents, surfaceId: number): void {
  if (ownedBy(surfaceId, webContents)) {
    destroySurface(surfaceId)
  }
}
