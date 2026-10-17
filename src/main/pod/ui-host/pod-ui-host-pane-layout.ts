// Fork-only (Pod): hands PodNative's pane layout to the one-app window's renderer
// (src/shared/pod-ui-host-pane-layout.ts; the renderer answers in src/renderer/src/pod/ui-host).
import { ipcMain, type BrowserWindow, type IpcMainEvent } from 'electron'
import {
  POD_UI_HOST_PANE_LAYOUT_IPC,
  readPodUiHostPaneLayoutReply,
  type PodUiHostPaneLayoutReply,
  type PodUiHostPaneLayoutRequest
} from '../../../shared/pod-ui-host-pane-layout'
import { rendererPublicationThrottle } from '../../window/renderer-publication-throttle'
import { setPodRendererPaneLayoutApply } from '../pane-layout/pod-pane-layout-sync'

const APPLY_TIMEOUT_MS = 5_000
let nextRequestId = 0

/** The renderer's answer; null when it can't give one (gone, loading, hung). */
export function applyRendererPaneLayout(
  window: BrowserWindow | null | undefined,
  request: PodUiHostPaneLayoutRequest,
  timeoutMs = APPLY_TIMEOUT_MS
): Promise<PodUiHostPaneLayoutReply | null> {
  if (!window || window.isDestroyed()) {
    return Promise.resolve(null)
  }
  const { webContents } = window
  if (webContents.isCrashed() || webContents.isLoadingMainFrame()) {
    return Promise.resolve(null)
  }
  const requestId = ++nextRequestId
  // Why a lease: a hidden renderer's timers are throttled, and the refit and republish run on them.
  const release = rendererPublicationThrottle.acquire(webContents)
  return new Promise((resolve) => {
    const finish = (reply: PodUiHostPaneLayoutReply | null): void => {
      release()
      clearTimeout(timer)
      ipcMain.removeListener(POD_UI_HOST_PANE_LAYOUT_IPC.applied, onApplied)
      resolve(reply)
    }
    const onApplied = (event: IpcMainEvent, id: unknown, reply: unknown): void => {
      if (event.sender.id === webContents.id && id === requestId) {
        finish(readPodUiHostPaneLayoutReply(reply))
      }
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    ipcMain.on(POD_UI_HOST_PANE_LAYOUT_IPC.applied, onApplied)
    webContents.send(POD_UI_HOST_PANE_LAYOUT_IPC.apply, requestId, request)
  })
}

/** Called once at startup, where Electron is loaded; the runtime only sees the function. */
export function installPodUiHostPaneLayout(): void {
  setPodRendererPaneLayoutApply((window, request) =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime's authoritative window is the BrowserWindow it attached.
    applyRendererPaneLayout(window as BrowserWindow, request)
  )
}
