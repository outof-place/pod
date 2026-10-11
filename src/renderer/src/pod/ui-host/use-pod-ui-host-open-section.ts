// Fork-only (Pod): PodNative opens a part of this window or of Settings it has no native version of
// yet (openSurface's `section`, src/main/pod/ui-host/pod-ui-host.ts), so its fallback lands there.
import { useEffect } from 'react'
import { TOGGLE_WORKSPACE_BOARD_EVENT } from '@/components/sidebar/useWorkspaceBoardPanel'
import { openNewWorkspaceFromShortcut } from '@/hooks/ipc-events/new-workspace-command'
import { TOGGLE_QUICK_COMMANDS_MENU_EVENT } from '@/lib/quick-commands-menu-events'
import { isSettingsNavigationTarget } from '@/lib/settings-navigation-types'
import { useAppStore } from '@/store'
import type { PodUiHostSectionRequest } from '../../../../shared/pod-ui-host-surface'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'

/** Carries out one request; false for a section this build doesn't know (it stays where it is). */
export function openPodUiHostSection(request: PodUiHostSectionRequest): boolean {
  const store = useAppStore.getState()
  if (request.surface === 'settings') {
    const repoId =
      request.section === 'repo' && request.worktreeId
        ? getRepoIdFromWorktreeId(request.worktreeId)
        : null
    const target = { pane: request.section, repoId }
    if (!isSettingsNavigationTarget(target)) {
      return false
    }
    store.openSettingsPage()
    store.openSettingsTarget(target)
    return true
  }
  switch (request.section) {
    case 'new-workspace':
      openNewWorkspaceFromShortcut(store)
      return true
    case 'add-project':
      store.openModal('add-repo')
      return true
    case 'tasks':
      store.openTaskPage()
      return true
    case 'workspace-board':
      store.setSidebarOpen(true)
      window.dispatchEvent(new CustomEvent(TOGGLE_WORKSPACE_BOARD_EVENT))
      return true
    case 'activity':
      store.setSidebarOpen(true)
      store.setSidebarBody('agents')
      return true
    case 'quick-commands':
      window.dispatchEvent(new CustomEvent(TOGGLE_QUICK_COMMANDS_MENU_EVENT))
      return true
    case 'search':
      store.showRightSidebarSearch()
      return true
    case 'explorer':
    case 'source-control':
    case 'checks':
    case 'ports':
      store.setRightSidebarOpen(true)
      store.setRightSidebarTab(request.section)
      return true
    default:
      return false
  }
}

export function usePodUiHostOpenSection(): void {
  useEffect(() => {
    // Undefined in the web client and in unit tests that stub only part of `window.api`.
    const api: Partial<Window['api']> | undefined =
      typeof window === 'undefined' ? undefined : window.api
    return api?.podUiHost?.onOpenSection?.(openPodUiHostSection)
  }, [])
}
