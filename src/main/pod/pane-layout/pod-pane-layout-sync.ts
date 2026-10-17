// Fork-only (Pod): session.tabs.updatePaneLayout for PodNative. With the one-app window the layout
// goes to its renderer, which owns the tab's panes; a headless host also keeps the active pane.
// Neither path activates the tab, focuses a pane or shows a window.
import type { RuntimeMobileSessionTabsSnapshot } from '../../../shared/runtime-types'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode
} from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { collectLayoutLeafIdsInOrder } from '../../../shared/workspace-layout/terminal-pane-tree'
import type {
  PodUiHostPaneLayoutReply,
  PodUiHostPaneLayoutRequest
} from '../../../shared/pod-ui-host-pane-layout'

export type PodPaneLayoutUpdateResult =
  | { updated: true; appliedBy: 'renderer' | 'headless' }
  | { updated: false; reason: string }

export type PodPaneLayoutArgs = {
  tabId: string
  root: TerminalPaneLayoutNode | null
  expandedLeafId: string | null
  activeLeafId?: string
}

type RendererPaneLayoutApply = (
  window: unknown,
  request: PodUiHostPaneLayoutRequest
) => Promise<PodUiHostPaneLayoutReply | null>

// Why a registry: the runtime stays Electron-free; main installs the IPC (pod-ui-host-pane-layout.ts).
let rendererPaneLayoutApply: RendererPaneLayoutApply | null = null

export function setPodRendererPaneLayoutApply(apply: RendererPaneLayoutApply | null): void {
  rendererPaneLayoutApply = apply
}

/** The runtime members these use; OrcaRuntimeService passes itself. */
export type PodPaneLayoutHost = {
  getAvailableAuthoritativeWindow(): unknown
  mobileSessionTabsByWorktree: ReadonlyMap<string, RuntimeMobileSessionTabsSnapshot>
  resolveMobileSessionHostTabId(
    snapshot: RuntimeMobileSessionTabsSnapshot,
    tabId: string
  ): string | null
  getWorkspaceSessionForWorktree(worktreeId: string): WorkspaceSessionState | null | undefined
  setWorkspaceSessionForWorktree(worktreeId: string, session: WorkspaceSessionState): void
  storeMobileSessionSnapshot(worktreeId: string, snapshot: RuntimeMobileSessionTabsSnapshot): void
  emitMobileSessionTabsSnapshot(snapshot: RuntimeMobileSessionTabsSnapshot): void
}

/** Answers once the renderer applied the layout or refused it. */
export async function applyPodPaneLayoutInWindow(
  host: PodPaneLayoutHost,
  worktreeId: string,
  args: PodPaneLayoutArgs
): Promise<PodPaneLayoutUpdateResult> {
  const window = host.getAvailableAuthoritativeWindow()
  if (!window || !rendererPaneLayoutApply) {
    return { updated: false, reason: 'renderer_unavailable' }
  }
  const snapshot = host.mobileSessionTabsByWorktree.get(worktreeId)
  const tabId = snapshot
    ? (host.resolveMobileSessionHostTabId(snapshot, args.tabId) ?? args.tabId)
    : args.tabId
  const reply = await rendererPaneLayoutApply(window, {
    worktreeId,
    tabId,
    root: args.root,
    expandedLeafId: args.expandedLeafId,
    ...(args.activeLeafId !== undefined ? { activeLeafId: args.activeLeafId } : {})
  })
  if (!reply) {
    return { updated: false, reason: 'renderer_timeout' }
  }
  return reply.applied
    ? { updated: true, appliedBy: 'renderer' }
    : { updated: false, reason: reply.reason }
}

/**
 * Before the headless write: an active pane the tab's layout (the client's splits, else the stored
 * ones) lacks refuses the whole update, so a refusal never leaves the splits written.
 */
export function refusePodHeadlessActiveLeaf(
  host: PodPaneLayoutHost,
  worktreeId: string,
  tabId: string,
  args: Pick<PodPaneLayoutArgs, 'root' | 'activeLeafId'>
): PodPaneLayoutUpdateResult | null {
  if (args.activeLeafId === undefined) {
    return null
  }
  const stored = host.getWorkspaceSessionForWorktree(worktreeId)?.terminalLayoutsByTabId?.[tabId]
  if (!stored) {
    return { updated: false, reason: 'tab_not_found' }
  }
  return collectLayoutLeafIdsInOrder(args.root ?? stored.root).includes(args.activeLeafId)
    ? null
    : { updated: false, reason: 'leaf_not_found' }
}

/**
 * After the headless write of `accepted` (the tab's stored layout): the client's active pane goes
 * on that layout and its snapshot. A leaf the layout lacks is refused; splits stay as written.
 */
export function applyPodHeadlessActiveLeaf(
  host: PodPaneLayoutHost,
  worktreeId: string,
  tabId: string,
  accepted: TerminalLayoutSnapshot | undefined,
  activeLeafId: string | undefined
): PodPaneLayoutUpdateResult {
  if (activeLeafId === undefined) {
    return { updated: true, appliedBy: 'headless' }
  }
  if (!accepted) {
    return { updated: false, reason: 'tab_not_found' }
  }
  if (!collectLayoutLeafIdsInOrder(accepted.root).includes(activeLeafId)) {
    return { updated: false, reason: 'leaf_not_found' }
  }
  const session = host.getWorkspaceSessionForWorktree(worktreeId)
  const layout = session?.terminalLayoutsByTabId?.[tabId]
  if (session && layout && layout.activeLeafId !== activeLeafId) {
    host.setWorkspaceSessionForWorktree(worktreeId, {
      ...session,
      terminalLayoutsByTabId: {
        ...session.terminalLayoutsByTabId,
        [tabId]: { ...layout, activeLeafId }
      }
    })
  }
  const snapshot = host.mobileSessionTabsByWorktree.get(worktreeId)
  if (snapshot) {
    publishActiveLeaf(host, worktreeId, snapshot, tabId, activeLeafId)
  }
  return { updated: true, appliedBy: 'headless' }
}

function publishActiveLeaf(
  host: PodPaneLayoutHost,
  worktreeId: string,
  snapshot: RuntimeMobileSessionTabsSnapshot,
  tabId: string,
  activeLeafId: string
): void {
  const leaves = snapshot.tabs.filter((tab) => tab.type === 'terminal' && tab.parentTabId === tabId)
  // Why: isActive marks the worktree's active tab's active pane; a tab that isn't active keeps none.
  const tabIsActive = leaves.some((tab) => tab.isActive)
  let changed = false
  const tabs = snapshot.tabs.map((tab) => {
    if (tab.type !== 'terminal' || tab.parentTabId !== tabId) {
      return tab
    }
    const isActive = tabIsActive && tab.leafId === activeLeafId
    if (tab.parentLayout?.activeLeafId === activeLeafId && tab.isActive === isActive) {
      return tab
    }
    changed = true
    return {
      ...tab,
      isActive,
      ...(tab.parentLayout ? { parentLayout: { ...tab.parentLayout, activeLeafId } } : {})
    }
  })
  if (!changed) {
    return
  }
  const next: RuntimeMobileSessionTabsSnapshot = {
    ...snapshot,
    publicationEpoch: `headless:${Date.now().toString(36)}`,
    snapshotVersion: snapshot.snapshotVersion + 1,
    tabs
  }
  host.storeMobileSessionSnapshot(worktreeId, next)
  host.emitMobileSessionTabsSnapshot(next)
}
