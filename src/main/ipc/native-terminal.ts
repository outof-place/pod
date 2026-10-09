import { ipcMain } from 'electron'
import type { NativeTerminalAppearance } from '../../shared/native-terminal-appearance'
import type { NativeTerminalFrame } from '../../shared/native-terminal-ipc'
import {
  createSurface,
  destroyOwnedSurface,
  focusSurface,
  installNativeTerminalDebugHooks,
  isNativeTerminalSupported,
  readSurfaceSelection,
  setSurfaceFrames,
  updateAppearance,
  writeSurfaceOutput
} from '../native-terminal/ghostty-native-terminal-host'

function isAppearance(value: unknown): value is NativeTerminalAppearance {
  return (
    typeof value === 'object' &&
    value !== null &&
    'fontFamily' in value &&
    typeof value.fontFamily === 'string' &&
    'fontSize' in value &&
    typeof value.fontSize === 'number' &&
    'theme' in value &&
    typeof value.theme === 'object' &&
    value.theme !== null
  )
}

function isSurfaceId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function isFrame(value: unknown): value is NativeTerminalFrame {
  return (
    Array.isArray(value) &&
    value.length === 6 &&
    isSurfaceId(value[0]) &&
    value.slice(1, 5).every((n) => typeof n === 'number' && Number.isFinite(n)) &&
    typeof value[5] === 'boolean'
  )
}

function zoomOf(value: unknown): number {
  return typeof value === 'number' && value > 0 && Number.isFinite(value) ? value : 1
}

const INVOKE_CHANNELS = [
  'nativeTerminal:isSupported',
  'nativeTerminal:create',
  'nativeTerminal:readSelection'
]
const SEND_CHANNELS = [
  'nativeTerminal:write',
  'nativeTerminal:setFrames',
  'nativeTerminal:focus',
  'nativeTerminal:setAppearance',
  'nativeTerminal:destroy'
]

export function registerNativeTerminalHandlers(): void {
  installNativeTerminalDebugHooks()
  for (const channel of INVOKE_CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  for (const channel of SEND_CHANNELS) {
    ipcMain.removeAllListeners(channel)
  }
  ipcMain.handle('nativeTerminal:isSupported', (): boolean => isNativeTerminalSupported())
  ipcMain.handle(
    'nativeTerminal:create',
    (event, appearance: unknown, zoomFactor: unknown): number | null =>
      isAppearance(appearance) ? createSurface(event.sender, appearance, zoomOf(zoomFactor)) : null
  )
  ipcMain.on('nativeTerminal:write', (event, surfaceId: unknown, data: unknown) => {
    if (isSurfaceId(surfaceId) && typeof data === 'string') {
      writeSurfaceOutput(event.sender, surfaceId, data)
    }
  })
  ipcMain.on('nativeTerminal:setFrames', (event, frames: unknown) => {
    if (Array.isArray(frames)) {
      setSurfaceFrames(event.sender, frames.filter(isFrame))
    }
  })
  ipcMain.on('nativeTerminal:focus', (event, surfaceId: unknown) => {
    if (isSurfaceId(surfaceId)) {
      focusSurface(event.sender, surfaceId)
    }
  })
  ipcMain.handle('nativeTerminal:readSelection', (event, surfaceId: unknown): string | null =>
    isSurfaceId(surfaceId) ? readSurfaceSelection(event.sender, surfaceId) : null
  )
  ipcMain.on('nativeTerminal:setAppearance', (_event, appearance: unknown, zoomFactor: unknown) => {
    if (isAppearance(appearance)) {
      updateAppearance(appearance, zoomOf(zoomFactor))
    }
  })
  ipcMain.on('nativeTerminal:destroy', (event, surfaceId: unknown) => {
    if (isSurfaceId(surfaceId)) {
      destroyOwnedSurface(event.sender, surfaceId)
    }
  })
}
