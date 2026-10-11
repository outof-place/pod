// Fork-only (Pod): the one-app main window starts hidden; with show: false alone Electron keeps its
// renderer visible, so it composites every change off screen. show() makes it visible as usual.
import type { BrowserWindow } from 'electron'
import { podBrowserPanesHostBrowserTabs } from '../browser-pane/pod-browser-pane-hooks'
import { isPodUiHostLaunch } from '../ui-host/pod-ui-host-launch'
import {
  rendererPublicationThrottle,
  type RendererPublicationThrottleTarget
} from '../../window/renderer-publication-throttle'

// Why: a hidden page's 1 Hz timers delayed the first graph ~0.6 s, and PodNative's first reads don't retry.
export const STARTUP_AWAKE_AFTER_LOAD_MS = 10_000

/** Only while one-app's panes own browser pages: a never-shown window's <webview> gets no frames to
 *  capture. POD_UI_HOST_RENDERER_VISIBLE=1 keeps today's window. */
export function podUiHostMainWindowOptions(
  uiHost: boolean = isPodUiHostLaunch(),
  env: NodeJS.ProcessEnv = process.env,
  panesHostTabs: boolean = podBrowserPanesHostBrowserTabs()
): { paintWhenInitiallyHidden?: boolean } {
  return uiHost && panesHostTabs && env.POD_UI_HOST_RENDERER_VISIBLE !== '1'
    ? { paintWhenInitiallyHidden: false }
    : {}
}

type StartupLifecycle = {
  onFirstLoad: (listener: () => void) => void
  onDestroyed: (listener: () => void) => void
}

type Leases = { acquire: (target: RendererPublicationThrottleTarget) => () => void }

/** A window that starts hidden stays awake until STARTUP_AWAKE_AFTER_LOAD_MS after its first load. */
export function holdWindowAwakeAtStartup(
  target: RendererPublicationThrottleTarget,
  lifecycle: StartupLifecycle,
  startsHidden: boolean,
  leases: Leases = rendererPublicationThrottle,
  awakeAfterLoadMs: number = STARTUP_AWAKE_AFTER_LOAD_MS
): void {
  if (!startsHidden) {
    return
  }
  // Why a lease: its release replays the hide that waking swallowed.
  const release = leases.acquire(target)
  let timer: ReturnType<typeof setTimeout> | null = null
  lifecycle.onFirstLoad(() => {
    timer = setTimeout(release, awakeAfterLoadMs)
  })
  lifecycle.onDestroyed(() => {
    if (timer) {
      clearTimeout(timer)
    }
    release()
  })
}

/** holdWindowAwakeAtStartup for the one-app main window. */
export function holdPodUiHostWindowAwakeAtStartup(window: BrowserWindow): void {
  const { webContents } = window
  holdWindowAwakeAtStartup(
    webContents,
    {
      onFirstLoad: (listener) => webContents.once('did-finish-load', listener),
      onDestroyed: (listener) => webContents.once('destroyed', listener)
    },
    Object.keys(podUiHostMainWindowOptions()).length > 0
  )
}
