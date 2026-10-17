// Fork-only (Pod): asks the one-app window's renderer to restart a failed shell's pane
// (src/shared/pod-ui-host-pane-restart.ts; the renderer answers in src/renderer/src/pod/ui-host).
import { BrowserWindow, ipcMain, type IpcMainEvent } from 'electron'
import {
  POD_UI_HOST_PANE_RESTART_IPC,
  type PodUiHostPaneRestartRequest
} from '../../../shared/pod-ui-host-pane-restart'
import { rendererPublicationThrottle } from '../../window/renderer-publication-throttle'
import { setPodRendererPaneRestart } from '../terminal-exit/pod-terminal-exit-restart'
import { setPodRendererRetainedExitNotice } from '../terminal-exit/pod-terminal-exit-resume'
import { listPodTerminalExits } from '../terminal-exit/pod-terminal-exits'

const RESTART_TIMEOUT_MS = 5_000
let nextRequestId = 0

/** Whether the renderer took the restart; false when it can't (gone, loading, hung). */
export function restartRendererPane(
  window: BrowserWindow | null | undefined,
  request: PodUiHostPaneRestartRequest,
  timeoutMs = RESTART_TIMEOUT_MS
): Promise<boolean> {
  if (!window || window.isDestroyed()) {
    return Promise.resolve(false)
  }
  const { webContents } = window
  if (webContents.isCrashed() || webContents.isLoadingMainFrame()) {
    return Promise.resolve(false)
  }
  const requestId = ++nextRequestId
  // Why a lease: a hidden renderer's timers are throttled, and the new shell's spawn runs on them.
  const release = rendererPublicationThrottle.acquire(webContents)
  return new Promise((resolve) => {
    const finish = (accepted: boolean): void => {
      release()
      clearTimeout(timer)
      ipcMain.removeListener(POD_UI_HOST_PANE_RESTART_IPC.restarted, onRestarted)
      resolve(accepted)
    }
    const onRestarted = (event: IpcMainEvent, id: unknown, accepted: unknown): void => {
      if (event.sender.id === webContents.id && id === requestId) {
        finish(accepted === true)
      }
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    ipcMain.on(POD_UI_HOST_PANE_RESTART_IPC.restarted, onRestarted)
    webContents.send(POD_UI_HOST_PANE_RESTART_IPC.restart, requestId, request)
  })
}

/** Called once at startup, where Electron is loaded; the runtime only sees the function. */
export function installPodUiHostPaneRestart(): void {
  setPodRendererPaneRestart((window, request) =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime's authoritative window is the BrowserWindow it attached.
    restartRendererPane(window as BrowserWindow, request)
  )
  setPodRendererRetainedExitNotice((window, pane) =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime's authoritative window is the BrowserWindow it attached.
    noteRetainedExit(window as BrowserWindow, pane)
  )
  // Why: a notice sent before the renderer subscribed is lost; it asks for the kept panes once.
  ipcMain.handle(POD_UI_HOST_PANE_RESTART_IPC.listRetained, (event) =>
    BrowserWindow.fromWebContents(event.sender) ? listPodTerminalExits() : []
  )
}

/** Tells the renderer a failed shell's pane was kept, so it drops the pane's agent resume. */
export function noteRetainedExit(
  window: BrowserWindow | null | undefined,
  pane: PodUiHostPaneRestartRequest
): void {
  if (window && !window.isDestroyed() && !window.webContents.isCrashed()) {
    window.webContents.send(POD_UI_HOST_PANE_RESTART_IPC.retained, pane)
  }
}
