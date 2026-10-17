// Fork-only (Pod): PodNative's Restart on a failed shell's pane, through this window, which owns the
// pane (src/shared/pod-ui-host-pane-restart.ts). A mounted pane restarts itself; one this window
// never mounted, or parked, starts a shell when it mounts. Either way the shell is a plain one: the
// pane's agent resume goes when main keeps the exit, and again here before the spawn.
import { useEffect } from 'react'
import type { PodUiHostPaneRestartRequest } from '../../../../shared/pod-ui-host-pane-restart'
import { parseLegacyNumericPaneKey } from '../../../../shared/stable-pane-id'
import { collectLayoutLeafIdsInOrder } from '../../../../shared/workspace-layout/terminal-pane-tree'
import { requestBackgroundTerminalWorktreeMount } from '@/components/terminal/background-terminal-worktree-mount'
import { useAppStore } from '@/store'

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

/**
 * Drops the pane's sleeping agent records, which its next spawn would resume. A legacy numeric key
 * names no leaf, so it goes only for a tab with this one pane.
 */
export function forgetPodPaneAgentResume(pane: PodUiHostPaneRestartRequest): void {
  const state = useAppStore.getState()
  const leaves = collectLayoutLeafIdsInOrder(state.terminalLayoutsByTabId[pane.tabId]?.root)
  // Why no leaves counts: a tab with no stored layout is a single-pane tab.
  const onlyPane = leaves.length === 0 || (leaves.length === 1 && leaves[0] === pane.leafId)
  const paneKeys = Object.entries(state.sleepingAgentSessionsByPaneKey)
    .filter(
      ([paneKey, record]) =>
        paneKey === `${pane.tabId}:${pane.leafId}` ||
        (onlyPane &&
          record.worktreeId === pane.worktreeId &&
          parseLegacyNumericPaneKey(paneKey)?.tabId === pane.tabId)
    )
    .map(([paneKey]) => paneKey)
  if (paneKeys.length > 0) {
    state.clearSleepingAgentSessionsByPaneKey(paneKeys)
  }
}

// Why: the mount would reattach to the dead PTY and show the exit again instead of spawning; a
// one-pane tab can name it on the tab itself, not in its layout.
function dropDeadPaneBinding(pane: PodUiHostPaneRestartRequest): void {
  const { terminalLayoutsByTabId, ptyIdsByTabId, setTabLayout, clearTabPtyId } =
    useAppStore.getState()
  const layout = terminalLayoutsByTabId[pane.tabId]
  if (layout?.ptyIdsByLeafId?.[pane.leafId]) {
    const { [pane.leafId]: _dead, ...bindings } = layout.ptyIdsByLeafId
    const { ptyIdsByLeafId: _bindings, ...rest } = layout
    setTabLayout(pane.tabId, {
      ...rest,
      ...(Object.keys(bindings).length > 0 ? { ptyIdsByLeafId: bindings } : {})
    })
  }
  if (pane.deadPtyId && ptyIdsByTabId[pane.tabId]?.includes(pane.deadPtyId)) {
    clearTabPtyId(pane.tabId, pane.deadPtyId)
  }
}

export function restartPodPane(request: PodUiHostPaneRestartRequest): boolean {
  forgetPodPaneAgentResume(request)
  const restarter = restartersByTabId.get(request.tabId)
  if (restarter) {
    return restarter(request.leafId)
  }
  dropDeadPaneBinding(request)
  requestBackgroundTerminalWorktreeMount({
    worktreeId: request.worktreeId,
    tabIds: [request.tabId]
  })
  return true
}

/** Subscribes this window to restarts and kept exits, and takes the exits kept before it did. */
export function subscribePodUiHostPaneRestart(
  podUiHost: Window['api']['podUiHost'] | undefined
): () => void {
  const stopRestarts = podUiHost?.onPaneRestart(restartPodPane)
  const stopRetained = podUiHost?.onPaneExitRetained(forgetPodPaneAgentResume)
  void podUiHost
    ?.listRetainedPaneExits()
    .then((panes) => panes.forEach(forgetPodPaneAgentResume))
    .catch(() => {})
  return () => {
    stopRestarts?.()
    stopRetained?.()
  }
}

export function usePodUiHostPaneRestart(): void {
  useEffect(() => {
    // Undefined in the web client and in unit tests that stub only part of `window.api`.
    const api: Partial<Window['api']> | undefined =
      typeof window === 'undefined' ? undefined : window.api
    return subscribePodUiHostPaneRestart(api?.podUiHost)
  }, [])
}
