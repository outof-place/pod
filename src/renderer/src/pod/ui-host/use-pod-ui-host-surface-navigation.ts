// Fork-only (Pod): PodNative's "Open in Classic Window → <section>" and "Classic Settings…" land on
// the settings pane, repo, anchor or top-level view they name, not the settings root.
import { useEffect } from 'react'
import { TOGGLE_WORKSPACE_BOARD_EVENT } from '@/components/sidebar/useWorkspaceBoardPanel'
import { openNewWorkspaceFromShortcut } from '@/hooks/ipc-events/new-workspace-command'
import { TOGGLE_QUICK_COMMANDS_MENU_EVENT } from '@/lib/quick-commands-menu-events'
import { isSettingsNavigationTarget } from '@/lib/settings-navigation-types'
import type { PodUiHostSurfaceNavigation } from '../../../../shared/pod-ui-host-surface'
import { useAppStore } from '../../store'

type NavigationStore = Pick<
  ReturnType<typeof useAppStore.getState>,
  | 'setSettingsSearchQuery'
  | 'openSettingsTarget'
  | 'openSettingsPage'
  | 'openActivityPage'
  | 'openAutomationsPage'
  | 'setSelectedAutomationId'
  | 'openSkillsPage'
  | 'openArtifactsPage'
  | 'openSpacePage'
  | 'activeModal'
  | 'activeView'
  | 'taskPageData'
  | 'openModal'
  | 'openTaskPage'
  | 'setSidebarOpen'
  | 'showRightSidebarSearch'
  | 'setRightSidebarOpen'
  | 'setRightSidebarTab'
>

export function applyPodUiHostSurfaceNavigation(
  navigation: PodUiHostSurfaceNavigation,
  store: NavigationStore = useAppStore.getState()
): void {
  if (navigation.surface === 'settings') {
    const target = {
      pane: navigation.section,
      repoId: navigation.repoId ?? null,
      ...(navigation.hostId ? { hostId: navigation.hostId } : {}),
      ...(navigation.item ? { sectionId: navigation.item } : {}),
      ...(navigation.intent ? { intent: navigation.intent } : {})
    }
    // Why: a stale settings search would hide the section this opens.
    store.setSettingsSearchQuery('')
    // An unknown pane (an older renderer) still opens Settings, at its root.
    if (isSettingsNavigationTarget(target)) {
      store.openSettingsTarget(target)
    }
    store.openSettingsPage()
    return
  }
  applyWindowSection(navigation, store)
}

/** A view of the window, with the same store actions and events its menus and shortcuts use. */
function applyWindowSection(navigation: PodUiHostSurfaceNavigation, store: NavigationStore): void {
  switch (navigation.section) {
    case 'activity':
      store.openActivityPage()
      return
    case 'automations':
      if (navigation.item) {
        store.setSelectedAutomationId(navigation.item)
      }
      store.openAutomationsPage()
      return
    case 'skills':
      store.openSkillsPage()
      return
    case 'artifacts':
      store.openArtifactsPage()
      return
    case 'space':
      store.openSpacePage()
      return
    case 'tasks':
      store.openTaskPage()
      return
    case 'new-workspace':
      openNewWorkspaceFromShortcut(store)
      return
    case 'add-project':
      store.openModal('add-repo')
      return
    case 'workspace-board':
      store.setSidebarOpen(true)
      window.dispatchEvent(new CustomEvent(TOGGLE_WORKSPACE_BOARD_EVENT))
      return
    case 'quick-commands':
      window.dispatchEvent(new CustomEvent(TOGGLE_QUICK_COMMANDS_MENU_EVENT))
      return
    case 'search':
      store.showRightSidebarSearch()
      return
    case 'explorer':
    case 'source-control':
    case 'checks':
    case 'ports':
      store.setRightSidebarOpen(true)
      store.setRightSidebarTab(navigation.section)
  }
}

export function usePodUiHostSurfaceNavigation(): void {
  useEffect(() => {
    // Undefined in the web client and in unit tests that stub only part of `window.api`.
    const api: Partial<Window['api']> | undefined =
      typeof window === 'undefined' ? undefined : window.api
    return api?.podUiHost?.onSurfaceNavigate?.((navigation) =>
      applyPodUiHostSurfaceNavigation(navigation)
    )
  }, [])
}
