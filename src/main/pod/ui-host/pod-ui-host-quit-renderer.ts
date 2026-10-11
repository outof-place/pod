// Fork-only (Pod): one-app's quit questions to the hidden window's renderer
// (src/shared/pod-ui-host-quit.ts; the renderer answers in src/renderer/src/pod/ui-host).
import { ipcMain, type BrowserWindow, type IpcMainEvent } from 'electron'
import { POD_UI_HOST_QUIT_IPC, PodUiHostQuitBlockers } from '../../../shared/pod-ui-host-quit'

// Why: the renderer caps its remote-work probe at 1.5 s; a renderer silent past this is hung.
const ASSESS_TIMEOUT_MS = 3_000
let nextRequestId = 0

/** What a quit would lose, from the renderer; null when it can't answer (gone, loading, hung). */
export function assessRendererQuit(
  window: BrowserWindow | null | undefined,
  timeoutMs = ASSESS_TIMEOUT_MS
): Promise<PodUiHostQuitBlockers | null> {
  if (!window || window.isDestroyed()) {
    return Promise.resolve(null)
  }
  const { webContents } = window
  if (webContents.isCrashed() || webContents.isLoadingMainFrame()) {
    return Promise.resolve(null)
  }
  const requestId = ++nextRequestId
  return new Promise((resolve) => {
    const finish = (blockers: PodUiHostQuitBlockers | null): void => {
      clearTimeout(timer)
      ipcMain.removeListener(POD_UI_HOST_QUIT_IPC.assessed, onAssessed)
      resolve(blockers)
    }
    const onAssessed = (event: IpcMainEvent, id: unknown, result: unknown): void => {
      if (event.sender.id !== webContents.id || id !== requestId) {
        return
      }
      const parsed = PodUiHostQuitBlockers.safeParse(result)
      finish(parsed.success ? parsed.data : null)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    ipcMain.on(POD_UI_HOST_QUIT_IPC.assessed, onAssessed)
    webContents.send(POD_UI_HOST_QUIT_IPC.assess, requestId)
  })
}

/** The quit is committed: the renderer's quit prompts stand down; `onVetoed` if it still keeps the window. */
export function commitRendererQuit(
  window: BrowserWindow | null | undefined,
  onVetoed: () => void
): void {
  if (!window || window.isDestroyed()) {
    return
  }
  // Why: a session checkpoint that fails vetoes the unload; the quit is off then (#15352).
  window.webContents.once('will-prevent-unload', onVetoed)
  window.webContents.send(POD_UI_HOST_QUIT_IPC.commit)
}
