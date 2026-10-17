// Fork-only (Pod): PodNative's pane layouts for this window's tabs (src/shared/pod-ui-host-pane-layout.ts).
// A mounted tab applies it to its panes; any other tab's stored layout takes it for its mount.
import { useEffect } from 'react'
import { useAppStore } from '@/store'
import type {
  PodUiHostPaneLayoutReply,
  PodUiHostPaneLayoutRequest
} from '../../../../shared/pod-ui-host-pane-layout'
import {
  applyPodPaneLayoutToMountedTab,
  applyPodPaneLayoutToStoredLayout,
  type MountedPaneLayoutTarget
} from './pod-terminal-pane-layout-apply'

type PaneLayoutApplier = (request: PodUiHostPaneLayoutRequest) => PodUiHostPaneLayoutReply

const appliersByTabId = new Map<string, PaneLayoutApplier>()

/** Returns the unregister; a remount's newer applier stays registered. */
export function registerPodPaneLayoutApplier(
  tabId: string,
  applier: PaneLayoutApplier
): () => void {
  appliersByTabId.set(tabId, applier)
  return () => {
    if (appliersByTabId.get(tabId) === applier) {
      appliersByTabId.delete(tabId)
    }
  }
}

export function applyPodPaneLayout(request: PodUiHostPaneLayoutRequest): PodUiHostPaneLayoutReply {
  const applier = appliersByTabId.get(request.tabId)
  if (applier) {
    return applier(request)
  }
  const { terminalLayoutsByTabId, setTabLayout } = useAppStore.getState()
  const { reply, layout } = applyPodPaneLayoutToStoredLayout(
    terminalLayoutsByTabId[request.tabId],
    request
  )
  if (layout) {
    setTabLayout(request.tabId, layout)
  }
  return reply
}

export function usePodUiHostPaneLayout(): void {
  useEffect(() => {
    // Undefined in the web client and in unit tests that stub only part of `window.api`.
    const api: Partial<Window['api']> | undefined =
      typeof window === 'undefined' ? undefined : window.api
    return api?.podUiHost?.onPaneLayout(applyPodPaneLayout)
  }, [])
}

/** A mounted TerminalPane's applier, registered under its tab for as long as it is mounted. */
export function usePodTerminalPaneLayoutApply(
  pane: Omit<MountedPaneLayoutTarget, 'ptyIdsByLeafId'> & { tabId: string }
): void {
  const {
    tabId,
    managerRef,
    containerRef,
    expandedPaneIdRef,
    expandedStyleSnapshotRef,
    setExpandedPane,
    refreshPaneSizes,
    persistLayoutSnapshot
  } = pane
  useEffect(
    () =>
      registerPodPaneLayoutApplier(tabId, (request) =>
        applyPodPaneLayoutToMountedTab(
          {
            managerRef,
            containerRef,
            expandedPaneIdRef,
            expandedStyleSnapshotRef,
            ptyIdsByLeafId: useAppStore.getState().terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId,
            setExpandedPane,
            refreshPaneSizes,
            persistLayoutSnapshot
          },
          request
        )
      ),
    [
      tabId,
      managerRef,
      containerRef,
      expandedPaneIdRef,
      expandedStyleSnapshotRef,
      setExpandedPane,
      refreshPaneSizes,
      persistLayoutSnapshot
    ]
  )
}
