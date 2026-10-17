// Fork-only (Pod): PodNative's pane layout on a tab of this window (src/shared/pod-ui-host-pane-layout.ts),
// mounted or not. Splits, the expanded pane and the active pane change; nothing takes focus.
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import {
  applyExpandedLayoutTo,
  restoreExpandedLayoutFrom
} from '@/components/terminal-pane/expand-collapse'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import type {
  PodUiHostPaneLayoutReply,
  PodUiHostPaneLayoutRequest
} from '../../../../shared/pod-ui-host-pane-layout'
import { collectLayoutLeafIdsInOrder } from '../../../../shared/workspace-layout/terminal-pane-tree'

export type MountedPaneLayoutTarget = {
  managerRef: React.RefObject<PaneManager | null>
  containerRef: React.RefObject<HTMLDivElement | null>
  expandedPaneIdRef: React.MutableRefObject<number | null>
  expandedStyleSnapshotRef: React.MutableRefObject<
    Map<HTMLElement, { display: string; flex: string }>
  >
  ptyIdsByLeafId: Readonly<Record<string, string>> | undefined
  setExpandedPane: (paneId: number | null) => void
  refreshPaneSizes: (focusActive: boolean) => void
  persistLayoutSnapshot: () => void
}

function hasSameLeaves(request: PodUiHostPaneLayoutRequest, leaves: ReadonlySet<string>): boolean {
  const requested = collectLayoutLeafIdsInOrder(request.root)
  return requested.length === leaves.size && requested.every((leafId) => leaves.has(leafId))
}

// Why: the manager's active-pane hook moves activity off a pty-less pane, and focuses the one it picks.
function isActiveLeafReady(
  ptyIdsByLeafId: Readonly<Record<string, string>> | undefined,
  leafId: string
): boolean {
  const bindings = ptyIdsByLeafId ?? {}
  return Object.keys(bindings).length === 0 || Boolean(bindings[leafId])
}

const refused = (reason: Extract<PodUiHostPaneLayoutReply, { applied: false }>['reason']) =>
  ({ applied: false, reason }) as const

export function applyPodPaneLayoutToMountedTab(
  target: MountedPaneLayoutTarget,
  request: PodUiHostPaneLayoutRequest
): PodUiHostPaneLayoutReply {
  const manager = target.managerRef.current
  if (!manager) {
    return refused('tab_not_found')
  }
  const paneIdByLeafId = new Map<string, number>(
    Array.from(manager.getLeafIdMap(), ([paneId, leafId]) => [leafId, paneId])
  )
  if (request.root && !hasSameLeaves(request, new Set(paneIdByLeafId.keys()))) {
    return refused('layout_mismatch')
  }
  const expandedPaneId =
    request.expandedLeafId === null ? null : paneIdByLeafId.get(request.expandedLeafId)
  const activePaneId =
    request.activeLeafId === undefined ? null : paneIdByLeafId.get(request.activeLeafId)
  if (expandedPaneId === undefined || activePaneId === undefined) {
    return refused('leaf_not_found')
  }
  if (request.activeLeafId && !isActiveLeafReady(target.ptyIdsByLeafId, request.activeLeafId)) {
    return refused('active_leaf_not_ready')
  }
  const previous = target.expandedPaneIdRef.current
  if (request.root) {
    // Why: geometry refuses a zoomed tree, so the zoom comes off first and goes back on below.
    restoreExpandedLayoutFrom(target.expandedStyleSnapshotRef.current)
    if (!manager.applyLayoutGeometry(request.root)) {
      if (previous !== null) {
        applyExpandedLayoutTo(previous, target)
      }
      return refused('layout_mismatch')
    }
  }
  const expanded =
    expandedPaneId !== null && applyExpandedLayoutTo(expandedPaneId, target) ? expandedPaneId : null
  if (expanded === null) {
    restoreExpandedLayoutFrom(target.expandedStyleSnapshotRef.current)
  }
  if (expanded !== previous) {
    target.setExpandedPane(expanded)
  }
  if (activePaneId !== null && manager.getActivePane()?.id !== activePaneId) {
    manager.setActivePane(activePaneId, { focus: false })
  }
  target.refreshPaneSizes(false)
  target.persistLayoutSnapshot()
  return { applied: true }
}

/** A tab this window hasn't mounted: its stored layout, which the mount replays. */
export function applyPodPaneLayoutToStoredLayout(
  layout: TerminalLayoutSnapshot | undefined,
  request: PodUiHostPaneLayoutRequest
): { reply: PodUiHostPaneLayoutReply; layout?: TerminalLayoutSnapshot } {
  if (!layout) {
    return { reply: refused('tab_not_found') }
  }
  const leaves = new Set(collectLayoutLeafIdsInOrder(layout.root))
  if (request.root && !hasSameLeaves(request, leaves)) {
    return { reply: refused('layout_mismatch') }
  }
  for (const leafId of [request.expandedLeafId, request.activeLeafId]) {
    if (leafId != null && !leaves.has(leafId)) {
      return { reply: refused('leaf_not_found') }
    }
  }
  if (request.activeLeafId && !isActiveLeafReady(layout.ptyIdsByLeafId, request.activeLeafId)) {
    return { reply: refused('active_leaf_not_ready') }
  }
  return {
    reply: { applied: true },
    layout: {
      ...layout,
      root: request.root ?? layout.root,
      expandedLeafId: request.expandedLeafId,
      ...(request.activeLeafId !== undefined ? { activeLeafId: request.activeLeafId } : {})
    }
  }
}
