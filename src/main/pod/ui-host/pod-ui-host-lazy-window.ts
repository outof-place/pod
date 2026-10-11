// Fork-only (Pod): the headless one-app runtime's window. None exists until PodNative asks for a
// surface; the request then waits for the new renderer to restore the session (it would drop the
// navigation before that), and closing the window ends its renderer (pod-ui-host-window.ts).
import { ipcMain, type BrowserWindow, type IpcMainEvent } from 'electron'
import { POD_UI_HOST_SURFACE_IPC } from '../../../shared/pod-ui-host-surface'

// Why: a renderer that never says it's ready (crashed, stuck restoring) still gets its window shown.
const READY_TIMEOUT_MS = 15_000

/** What this reads of the main window. */
export type PodUiHostLazyWindowTarget = Pick<BrowserWindow, 'isDestroyed'> & {
  webContents: Pick<BrowserWindow['webContents'], 'id'>
}

export type PodUiHostLazyWindowDeps<Request> = {
  getWindow: () => PodUiHostLazyWindowTarget | null
  /** False while no window may open (startup, a blocked activation, a quit). */
  canOpen: () => boolean
  openWindow: () => void
  /** Carries the request out in a window whose renderer is ready. */
  present: (request: Request) => void
  /** No window could open for it. */
  refuse: (request: Request) => void
  log: (message: string) => void
  readyTimeoutMs?: number
}

export class PodUiHostLazyWindow<Request> {
  private pending: Request | null = null
  private readyWebContentsId: number | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly onReady = (event: IpcMainEvent): void => this.rendererReady(event.sender.id)

  constructor(private readonly deps: PodUiHostLazyWindowDeps<Request>) {
    ipcMain.on(POD_UI_HOST_SURFACE_IPC.ready, this.onReady)
  }

  /** The latest request wins: PodNative asks again for what the user clicked last. */
  request(request: Request): void {
    const window = this.liveWindow()
    if (window && window.webContents.id === this.readyWebContentsId) {
      this.deps.present(request)
      return
    }
    if (!window && !this.deps.canOpen()) {
      this.deps.log('ui-host: no window may open now; surface refused')
      this.deps.refuse(request)
      return
    }
    this.pending = request
    if (!this.timer) {
      this.armTimeout()
    }
    if (!window) {
      this.deps.log('ui-host: opening the window for a surface')
      this.deps.openWindow()
    }
  }

  dispose(): void {
    this.clearTimer()
    this.pending = null
    ipcMain.removeListener(POD_UI_HOST_SURFACE_IPC.ready, this.onReady)
  }

  private rendererReady(webContentsId: number): void {
    if (this.liveWindow()?.webContents.id !== webContentsId) {
      return
    }
    this.readyWebContentsId = webContentsId
    this.flush()
  }

  private flush(): void {
    this.clearTimer()
    const request = this.pending
    this.pending = null
    if (request !== null && this.liveWindow()) {
      this.deps.present(request)
    }
  }

  private armTimeout(): void {
    this.timer = setTimeout(() => {
      this.timer = null
      this.deps.log('ui-host: the new renderer never said it was ready; showing the window anyway')
      this.flush()
    }, this.deps.readyTimeoutMs ?? READY_TIMEOUT_MS)
    this.timer.unref?.()
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private liveWindow(): PodUiHostLazyWindowTarget | null {
    const window = this.deps.getWindow()
    return window && !window.isDestroyed() ? window : null
  }
}
