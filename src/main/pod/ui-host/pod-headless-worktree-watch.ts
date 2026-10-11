// Fork-only (Pod): the worktree base watcher (worktree-base-directory-watcher.ts) is armed with the
// main window (attach-main-window-services.ts), which the headless one-app runtime opens only for a
// fallback surface. Without it a branch switched in a terminal reached PodNative at its next
// catalog read. Here the watcher runs windowless and tells remote clients (worktreesChanged); an
// open window takes the watches over, and they come back here when it closes.
import type { BrowserWindow } from 'electron'
import type { Store } from '../../persistence'
import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'
import { setWorktreeCatalogRemoteClientNotifier } from '../../ipc/watched-worktree-catalog-notification'
import {
  scheduleCurrentWorktreeBaseDirectoryWatcherSync,
  scheduleWorktreeBaseDirectoryWatcherSync,
  setWorktreeBaseDirectoryWatcherSyncContext
} from '../../ipc/worktree-base-directory-watcher'
import { isPodHeadlessUiHost } from './pod-ui-host-launch'

type HeadlessWatchRuntime = Parameters<typeof setWorktreeCatalogRemoteClientNotifier>[0] & {
  onClientEvent(
    listener: (event: RuntimeClientEvent) => void,
    options?: { consumesTerminalSideEffects?: boolean }
  ): () => void
}

let armed: { store: Store; window: BrowserWindow } | null = null

/** The watcher's window while none is open: no renderer to tell, and it lasts as long as the process. */
export function createPodWindowlessWatchTarget(): BrowserWindow {
  const target = { isDestroyed: () => false, webContents: { send: () => {} } }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the base watcher reaches its window only through isDestroyed and webContents.send (its own tests drive it with this double).
  return target as unknown as BrowserWindow
}

/** Headless one-app runtime only; a no-op in every other launch. */
export function installPodHeadlessWorktreeWatch(store: Store, runtime: HeadlessWatchRuntime): void {
  if (armed || !isPodHeadlessUiHost()) {
    return
  }
  armed = { store, window: createPodWindowlessWatchTarget() }
  setWorktreeCatalogRemoteClientNotifier(runtime)
  rearmPodHeadlessWorktreeWatch()
  // Why: a repo added over RPC resyncs nothing (only the IPC path in repos-changed-notification.ts does).
  runtime.onClientEvent(
    (event) => {
      if (event.type === 'reposChanged') {
        scheduleCurrentWorktreeBaseDirectoryWatcherSync()
      }
    },
    { consumesTerminalSideEffects: false }
  )
}

/** The window closed: the watches come back to the windowless target. */
export function rearmPodHeadlessWorktreeWatch(): void {
  if (!armed) {
    return
  }
  setWorktreeBaseDirectoryWatcherSyncContext(armed.store, armed.window)
  scheduleWorktreeBaseDirectoryWatcherSync(armed.store, armed.window)
}
