// Fork-only (Pod): PodNative's Restart on a failed shell's pane, through this window, which owns the
// pane (src/shared/pod-ui-host-pane-restart.ts). A mounted pane restarts itself; one this window
// never mounted, or parked, starts a shell when it mounts.
import { useEffect } from 'react'
import type { PodUiHostPaneRestartRequest } from '../../../../shared/pod-ui-host-pane-restart'
import { requestBackgroundTerminalWorktreeMount } from '@/components/terminal/background-terminal-worktree-mount'

/** A mounted tab's restart for one of its leaves; false when it has no such leaf. */
type PaneRestarter = (leafId: string) => boolean

const restartersByTabId = new Map<string, PaneRestarter>()

/** Returns the unregister; a remount's newer restarter stays registered. */
export function registerPodPaneRestarter(tabId: string, restarter: PaneRestarter): () => void {
  restartersByTabId.set(tabId, restarter)
  return () => {
    if (restartersByTabId.get(tabId) === restarter) {
      restartersByTabId.delete(tabId)
    }
  }
}

export function restartPodPane(request: PodUiHostPaneRestartRequest): boolean {
  const restarter = restartersByTabId.get(request.tabId)
  if (restarter) {
    return restarter(request.leafId)
  }
  requestBackgroundTerminalWorktreeMount({
    worktreeId: request.worktreeId,
    tabIds: [request.tabId]
  })
  return true
}

export function usePodUiHostPaneRestart(): void {
  useEffect(() => {
    // Undefined in the web client and in unit tests that stub only part of `window.api`.
    const api: Partial<Window['api']> | undefined =
      typeof window === 'undefined' ? undefined : window.api
    return api?.podUiHost?.onPaneRestart(restartPodPane)
  }, [])
}
