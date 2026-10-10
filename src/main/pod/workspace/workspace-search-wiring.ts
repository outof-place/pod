import { notifyExternalSearchWorktreeLifecycle } from '../../search/external-workspace-search-provider'
import { getPodSearchIndexStatus } from '../search/install-pod-native-search'
import {
  onWorkspaceRootsChanged,
  registerWorkspaceIndexStatusProvider,
  type WorkspaceRootEvent
} from './workspace-root-events'

export type SearchWorktreeLifecycleEvent = { kind: 'created' | 'removed'; path: string }

/** The search provider's register/forget for one root event; a move forgets the old root first. */
export function toSearchWorktreeLifecycleEvents(
  event: WorkspaceRootEvent
): SearchWorktreeLifecycleEvent[] {
  switch (event.kind) {
    case 'added':
      return [{ kind: 'created', path: event.path }]
    case 'removed':
      return [{ kind: 'removed', path: event.path }]
    case 'moved':
      return [
        { kind: 'removed', path: event.previousPath },
        { kind: 'created', path: event.path }
      ]
  }
}

/** Connects workspace roots to Pod native search; both ends are no-ops while search is off. */
export function wireWorkspaceToPodSearch(isSearchEnabled: () => boolean): () => void {
  const unregisterStatus = registerWorkspaceIndexStatusProvider(
    getPodSearchIndexStatus,
    isSearchEnabled
  )
  const unsubscribe = onWorkspaceRootsChanged((event) => {
    for (const lifecycle of toSearchWorktreeLifecycleEvents(event)) {
      notifyExternalSearchWorktreeLifecycle(lifecycle)
    }
  })
  return () => {
    unsubscribe()
    unregisterStatus()
  }
}
