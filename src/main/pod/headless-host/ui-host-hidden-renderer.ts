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

/** True when the one-app main window starts hidden (podUiHostMainWindowOptions applies). */
export function podUiHostWindowStartsHidden(): boolean {
  return Object.keys(podUiHostMainWindowOptions()).length > 0
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
    podUiHostWindowStartsHidden()
  )
}

// Why: an awake renderer handles a send and publishes its result (a tab, a focus) well within this.
export const SEND_WAKE_MS = 3_000

// Background refreshes nobody waits on; waking for each would undo the hidden start.
export const SEND_WAKE_EXEMPT: ReadonlySet<string> = new Set([
  'automationsChanged',
  'worktreesChanged',
  'worktreeBaseStatus',
  'worktreeRemoteBranchConflict',
  'reposChanged',
  'browserDriverChanged',
  'browserRemoteViewersChanged',
  'clientHostedBrowserRowsChanged'
])

/**
 * Wakes a hidden window for each runtime request: a notifier method that returns a promise holds a
 * lease until it settles (after 5 min hidden a terminal create took 2.2 s, not 0.1 s); any other
 * send holds one for SEND_WAKE_MS (a files.open tab never showed), except SEND_WAKE_EXEMPT.
 * Returns `notifier`, wrapped in place.
 */
export function leaseRendererRequests<T extends object>(
  target: RendererPublicationThrottleTarget,
  notifier: T,
  enabled: boolean,
  leases: Leases = rendererPublicationThrottle,
  sendWakeMs: number = SEND_WAKE_MS
): T {
  if (!enabled) {
    return notifier
  }
  for (const key of Object.keys(notifier)) {
    const method: unknown = Reflect.get(notifier, key)
    if (typeof method !== 'function') {
      continue
    }
    const wakesForSends = !SEND_WAKE_EXEMPT.has(key)
    Reflect.set(notifier, key, (...args: unknown[]) => {
      // Why before the call: the renderer must be awake when the message lands.
      const release = wakesForSends ? leases.acquire(target) : null
      let result: unknown
      try {
        result = Reflect.apply(method, notifier, args)
      } catch (error) {
        release?.()
        throw error
      }
      if (result instanceof Promise) {
        const releaseRequest = release ?? leases.acquire(target)
        result.then(releaseRequest, releaseRequest)
      } else if (release) {
        setTimeout(release, sendWakeMs)
      }
      return result
    })
  }
  return notifier
}

/** leaseRendererRequests for the one-app main window's runtime notifier. */
export function podUiHostLeasedNotifier<T extends object>(window: BrowserWindow, notifier: T): T {
  return leaseRendererRequests(window.webContents, notifier, podUiHostWindowStartsHidden())
}
