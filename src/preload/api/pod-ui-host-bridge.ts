import { ipcRenderer } from 'electron'
import { POD_UI_HOST_QUIT_IPC } from '../../shared/pod-ui-host-quit'
import { ORCA_APP_RESTART_STARTED_EVENT } from '../../shared/updater-renderer-events'
import type { PreloadApi } from '../api-types'

// Why the restart event: a committed one-app quit is one the user already confirmed in PodNative,
// so the renderer's quit prompts (in a hidden window) stand down as for a restart; a vetoed unload
// clears it again (renderer-restart-wiring.ts).
ipcRenderer.on(POD_UI_HOST_QUIT_IPC.commit, () => {
  window.dispatchEvent(new Event(ORCA_APP_RESTART_STARTED_EVENT))
})

export const podUiHostApi = {
  onQuitAssess: (assess) => {
    const listener = (_event: Electron.IpcRendererEvent, requestId: unknown): void => {
      void assess().then(
        (blockers) => ipcRenderer.send(POD_UI_HOST_QUIT_IPC.assessed, requestId, blockers),
        () => ipcRenderer.send(POD_UI_HOST_QUIT_IPC.assessed, requestId, null)
      )
    }
    ipcRenderer.on(POD_UI_HOST_QUIT_IPC.assess, listener)
    return () => ipcRenderer.removeListener(POD_UI_HOST_QUIT_IPC.assess, listener)
  }
} satisfies PreloadApi['podUiHost']
