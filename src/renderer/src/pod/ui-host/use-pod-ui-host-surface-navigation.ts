// Fork-only (Pod): PodNative's "Open in Classic Window → <section>" and "Classic Settings…" land on
// the settings pane, repo, anchor or top-level view they name, not the settings root.
import { useEffect } from 'react'
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
