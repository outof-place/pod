// Fork-only (Pod): main-process services attach-main-window-services.ts arms with the main window,
// which the headless one-app runtime opens only for a fallback surface. Without them a branch
// switched in a terminal reached PodNative at its next catalog read, an external `git init` never
// upgraded a folder project, and terminal history and OpenCode overlays were never collected.
// Here they run windowless and tell remote clients; an open window takes the watches over, and
// they come back here when it closes. The TCC prompt watch stays out: Pod's profile cuts it anyway.
import type { BrowserWindow } from 'electron'
import type { Store } from '../../persistence'
import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'
import { setRepoRemoteClientNotifier } from '../../ipc/repos/repos-changed-notification'
import { setWorktreeCatalogRemoteClientNotifier } from '../../ipc/watched-worktree-catalog-notification'
import {
  scheduleCurrentWorktreeBaseDirectoryWatcherSync,
  scheduleWorktreeBaseDirectoryWatcherSync,
  setWorktreeBaseDirectoryWatcherSyncContext
} from '../../ipc/worktree-base-directory-watcher'
import { startFolderRepoGitUpgradeWatch } from '../../ipc/folder-repo-git-upgrade'
import { scheduleHistoryGc } from '../../terminal-history-gc'
import { getKnownWorktreeIdsForHistoryGc } from '../../window/history-gc-worktree-ids'
import { openCodeHookService, openCode2HookService } from '../../opencode/hook-service'
import { listLiveDaemonPtyIds } from '../../daemon/daemon-provider-state'
import { isPodHeadlessUiHost } from './pod-ui-host-launch'

type HeadlessServicesRuntime = Parameters<typeof setWorktreeCatalogRemoteClientNotifier>[0] &
  Parameters<typeof setRepoRemoteClientNotifier>[0] & {
    onClientEvent(
      listener: (event: RuntimeClientEvent) => void,
      options?: { consumesTerminalSideEffects?: boolean }
    ): () => void
  }

let armed: { store: Store; window: BrowserWindow } | null = null

/** The services' window while none is open: no renderer to tell, and it lasts as long as the process. */
export function createPodWindowlessTarget(): BrowserWindow {
  const target = {
    isDestroyed: () => false,
    webContents: { send: () => {} }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these services reach their window only through isDestroyed and webContents.send (the watchers' own tests drive them with this double).
  return target as unknown as BrowserWindow
}

/** Headless one-app runtime only; a no-op in every other launch. */
export function installPodHeadlessWindowServices(
  store: Store,
  runtime: HeadlessServicesRuntime
): void {
  if (armed || !isPodHeadlessUiHost()) {
    return
  }
  armed = { store, window: createPodWindowlessTarget() }
  setWorktreeCatalogRemoteClientNotifier(runtime)
  // Why: the folder upgrade announces through repos-changed-notification.ts, which tells clients only so.
  setRepoRemoteClientNotifier(runtime)
  rearmPodHeadlessWindowServices()
  // Why: a repo added over RPC resyncs nothing (only the IPC path in repos-changed-notification.ts does).
  runtime.onClientEvent(
    (event) => {
      if (event.type === 'reposChanged') {
        scheduleCurrentWorktreeBaseDirectoryWatcherSync()
      }
    },
    { consumesTerminalSideEffects: false }
  )
  // Each one-shot and idempotent: a window's attach later finds them scheduled.
  scheduleHistoryGc(async () => getKnownWorktreeIdsForHistoryGc(store))
  openCodeHookService.configDirGc.schedule(listLiveDaemonPtyIds)
  openCode2HookService.configDirGc.schedule(listLiveDaemonPtyIds)
}

/** The window closed (or none opened yet): the watches come back to the windowless target. */
export function rearmPodHeadlessWindowServices(): void {
  if (!armed) {
    return
  }
  setWorktreeBaseDirectoryWatcherSyncContext(armed.store, armed.window)
  scheduleWorktreeBaseDirectoryWatcherSync(armed.store, armed.window)
  startFolderRepoGitUpgradeWatch(armed.store, armed.window)
}
