// Fork-only (Pod): session.tabs.restartTerminal. A plain shell in the failed pane's start folder, as
// the desktop's Restart starts a 'process-failed' pane (terminal-process-exit-restart.ts).
import type {
  RuntimeMobileSessionCreateTerminalResult,
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../../shared/runtime-types'
import type { PodUiHostPaneRestartRequest } from '../../../shared/pod-ui-host-pane-restart'
import {
  clearPodTerminalExit,
  getPodTerminalExit,
  recordPodTerminalExit
} from './pod-terminal-exits'

const RENDERER_RESTART_TIMEOUT_MS = 10_000
const READY_POLL_MS = 100

type RendererPaneRestart = (
  window: unknown,
  request: PodUiHostPaneRestartRequest
) => Promise<boolean>

// Why a registry: the runtime stays Electron-free; main installs the IPC (pod-ui-host-pane-restart.ts).
let rendererPaneRestart: RendererPaneRestart | null = null

export function setPodRendererPaneRestart(restart: RendererPaneRestart | null): void {
  rendererPaneRestart = restart
}

/** The runtime members a restart uses; OrcaRuntimeService passes itself. */
export type PodTerminalRestartHost = {
  getValidatedExplicitWorktreeIdSelector(selector: string): string | null
  resolveWorktreeSelector(selector: string): Promise<{ id: string }>
  hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId: string): void
  refreshMobileSessionPtyRecords(worktreeId: string): Promise<unknown>
  mobileSessionTabsByWorktree: ReadonlyMap<string, RuntimeMobileSessionTabsSnapshot>
  joinPaneMaterialization(worktreeId: string, paneKey: string): Promise<void> | null
  beginPaneMaterialization(worktreeId: string, paneKey: string): () => void
  getAvailableAuthoritativeWindow(): unknown
  getMobileSessionTabsForWorktree(worktreeId: string): RuntimeMobileSessionTabsResult
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
    const window = host.getAvailableAuthoritativeWindow()
    if (window && rendererPaneRestart) {
      // Why the renderer: with a window it owns the pane, and only its own spawn drops the overlay.
      const deadPtyId = tab.ptyId ?? tab.parentLayout?.ptyIdsByLeafId?.[tab.leafId] ?? undefined
      const pane = {
        worktreeId,
        tabId: tab.parentTabId,
        leafId: tab.leafId,
        ...(deadPtyId ? { deadPtyId } : {})
      }
      if (!(await rendererPaneRestart(window, pane))) {
        throw new Error('terminal_restart_failed')
      }
      return { terminal: await waitForReadyLeaf(host, pane) }
    }
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

/** The leaf's handle once the renderer's new shell is live in it. */
async function waitForReadyLeaf(
  host: PodTerminalRestartHost,
  pane: PodUiHostPaneRestartRequest,
  timeoutMs = RENDERER_RESTART_TIMEOUT_MS
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const leaf = host
      .getMobileSessionTabsForWorktree(pane.worktreeId)
      .tabs.find(
        (candidate) =>
          candidate.type === 'terminal' &&
          candidate.parentTabId === pane.tabId &&
          candidate.leafId === pane.leafId
      )
    if (leaf?.type === 'terminal' && leaf.status === 'ready') {
      return leaf.terminal
    }
    if (Date.now() >= deadline) {
      throw new Error('terminal_restart_timed_out')
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS))
  }
}
