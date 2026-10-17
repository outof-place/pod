// Fork-only (Pod): session.tabs.restartTerminal. A plain shell in the failed pane's start folder, as
// the desktop's Restart starts a 'process-failed' pane (terminal-process-exit-restart.ts).
import type {
  RuntimeMobileSessionCreateTerminalResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../../shared/runtime-types'
import {
  clearPodTerminalExit,
  getPodTerminalExit,
  recordPodTerminalExit
} from './pod-terminal-exits'

/** The runtime members a restart uses; OrcaRuntimeService passes itself. */
export type PodTerminalRestartHost = {
  getValidatedExplicitWorktreeIdSelector(selector: string): string | null
  resolveWorktreeSelector(selector: string): Promise<{ id: string }>
  hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId: string): void
  refreshMobileSessionPtyRecords(worktreeId: string): Promise<unknown>
  mobileSessionTabsByWorktree: ReadonlyMap<string, RuntimeMobileSessionTabsSnapshot>
  joinPaneMaterialization(worktreeId: string, paneKey: string): Promise<void> | null
  beginPaneMaterialization(worktreeId: string, paneKey: string): () => void
  createRuntimeOwnedMobileSessionTerminal(
    worktreeId: string,
    activate: boolean,
    afterTabId: string | undefined,
    opts: {
      identity: { tabId: string; leafId: string }
      cwd?: string
      targetGroupId?: string
    }
  ): Promise<RuntimeMobileSessionCreateTerminalResult>
}

export async function restartPodExitedTerminal(
  host: PodTerminalRestartHost,
  worktreeSelector: string,
  tabId: string,
  leafId?: string
): Promise<{ terminal: string }> {
  const worktreeId =
    host.getValidatedExplicitWorktreeIdSelector(worktreeSelector) ??
    (await host.resolveWorktreeSelector(worktreeSelector)).id
  host.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId)
  await host.refreshMobileSessionPtyRecords(worktreeId)
  const snapshot = host.mobileSessionTabsByWorktree.get(worktreeId)
  const tab = snapshot?.tabs.find(
    (candidate) =>
      candidate.type === 'terminal' &&
      (candidate.id === tabId || candidate.parentTabId === tabId) &&
      (!leafId || candidate.leafId === leafId)
  )
  if (tab?.type !== 'terminal') {
    throw new Error('tab_not_found')
  }
  const exit = getPodTerminalExit(worktreeId, tab.parentTabId, tab.leafId)
  if (!exit) {
    throw new Error('terminal_not_exited')
  }
  const paneKey = `${tab.parentTabId}:${tab.leafId}`
  if (host.joinPaneMaterialization(worktreeId, paneKey)) {
    throw new Error('terminal_restart_in_progress')
  }
  const finishMaterialization = host.beginPaneMaterialization(worktreeId, paneKey)
  clearPodTerminalExit(worktreeId, tab.parentTabId, tab.leafId)
  try {
    const created = await host.createRuntimeOwnedMobileSessionTerminal(
      worktreeId,
      false,
      undefined,
      {
        identity: { tabId: tab.parentTabId, leafId: tab.leafId },
        cwd: tab.startupCwd,
        targetGroupId: snapshot?.tabGroups?.find((group) =>
          group.tabOrder.includes(tab.parentTabId)
        )?.id
      }
    )
    if (!created.tab.terminal) {
      throw new Error('terminal_restart_failed')
    }
    return { terminal: created.tab.terminal }
  } catch (error) {
    // Why: a failed restart keeps the overlay up, so the client can offer Restart again.
    recordPodTerminalExit({ worktreeId, parentTabId: tab.parentTabId, leafId: tab.leafId }, exit)
    throw error
  } finally {
    finishMaterialization()
  }
}
