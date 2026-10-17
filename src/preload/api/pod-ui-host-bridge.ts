import { ipcRenderer } from 'electron'
import { POD_UI_HOST_QUIT_IPC } from '../../shared/pod-ui-host-quit'
import { POD_UI_HOST_SLEEP_IPC } from '../../shared/pod-ui-host-sleep'
import {
  POD_UI_HOST_PANE_RESTART_IPC,
  PodUiHostPaneRestartRequest
} from '../../shared/pod-ui-host-pane-restart'
import {
  isPodUiHostSurfaceNavigation,
  POD_UI_HOST_SURFACE_IPC
} from '../../shared/pod-ui-host-surface'
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
  },
  surfaceReady: () => ipcRenderer.send(POD_UI_HOST_SURFACE_IPC.ready),
  onSurfaceNavigate: (navigate) => {
    const listener = (_event: Electron.IpcRendererEvent, navigation: unknown): void => {
      if (isPodUiHostSurfaceNavigation(navigation)) {
        navigate(navigation)
      }
    }
    ipcRenderer.on(POD_UI_HOST_SURFACE_IPC.navigate, listener)
    return () => ipcRenderer.removeListener(POD_UI_HOST_SURFACE_IPC.navigate, listener)
  },
  beginRuntimeSleep: (worktreeId) => ipcRenderer.send(POD_UI_HOST_SLEEP_IPC.begin, worktreeId),
  sleepRuntimeTerminals: async (worktreeId) => {
    await ipcRenderer.invoke(POD_UI_HOST_SLEEP_IPC.runtimeTerminals, worktreeId)
  },
  onPaneRestart: (restart) => {
    const listener = (_event: Electron.IpcRendererEvent, requestId: unknown, request: unknown) => {
      const parsed = PodUiHostPaneRestartRequest.safeParse(request)
      ipcRenderer.send(
        POD_UI_HOST_PANE_RESTART_IPC.restarted,
        requestId,
        parsed.success && restart(parsed.data)
      )
    }
    ipcRenderer.on(POD_UI_HOST_PANE_RESTART_IPC.restart, listener)
    return () => ipcRenderer.removeListener(POD_UI_HOST_PANE_RESTART_IPC.restart, listener)
  },
  onPaneExitRetained: (retained) => {
    const listener = (_event: Electron.IpcRendererEvent, pane: unknown) => {
      const parsed = PodUiHostPaneRestartRequest.safeParse(pane)
      if (parsed.success) {
        retained(parsed.data)
      }
    }
    ipcRenderer.on(POD_UI_HOST_PANE_RESTART_IPC.retained, listener)
    return () => ipcRenderer.removeListener(POD_UI_HOST_PANE_RESTART_IPC.retained, listener)
  }
} satisfies PreloadApi['podUiHost']
