// Fork-only (Pod): the section of a PodNative surface request, handed to the renderer once the
// window shows: a settings pane (its repo, anchor or intent) or a top-level view and its item.
import type { BrowserWindow } from 'electron'
import {
  POD_UI_HOST_SURFACE_IPC,
  type PodUiHostSurfaceNavigation
} from '../../../shared/pod-ui-host-surface'
import type { PodUiHostOpenSurface } from './pod-ui-host-protocol'

export function podUiHostSurfaceNavigation(
  request: PodUiHostOpenSurface
): PodUiHostSurfaceNavigation | null {
  if (!request.section) {
    return null
  }
  return {
    surface: request.surface,
    section: request.section,
    ...(request.repoId ? { repoId: request.repoId } : {}),
    ...(request.hostId ? { hostId: request.hostId } : {}),
    ...(request.item ? { item: request.item } : {}),
    ...(request.intent ? { intent: request.intent } : {})
  }
}

type NavigationTarget = {
  isDestroyed: () => boolean
  webContents: Pick<BrowserWindow['webContents'], 'send'>
}

export function sendPodUiHostSurfaceNavigation(
  window: NavigationTarget | null,
  navigation: PodUiHostSurfaceNavigation | null
): void {
  if (navigation && window && !window.isDestroyed()) {
    window.webContents.send(POD_UI_HOST_SURFACE_IPC.navigate, navigation)
  }
}
