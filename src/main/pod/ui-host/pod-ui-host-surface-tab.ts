// Fork-only (Pod): which renderer route a surface's tab takes. PodNative names a runtime tab when it
// asks for the window (Open in Classic Window on a file); a renderer focuses a terminal through
// ui:focusTerminal, and a file, diff, browser or agent tab only through ui:focusEditorTab.
import type { Tab } from '../../../shared/tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

export type PodUiHostSessionSource = {
  getWorkspaceSessionHostIds: () => readonly string[]
  getWorkspaceSession: (hostId?: string | null) => Pick<WorkspaceSessionState, 'unifiedTabs'>
}

/** The worktree's tab in whichever host's session holds it (an SSH worktree's sits in its host's). */
function findSurfaceTab(
  sessions: PodUiHostSessionSource,
  worktreeId: string,
  tabId: string
): Tab | null {
  for (const hostId of sessions.getWorkspaceSessionHostIds()) {
    const tab = sessions
      .getWorkspaceSession(hostId)
      .unifiedTabs?.[worktreeId]?.find((item) => item.id === tabId || item.entityId === tabId)
    if (tab) {
      return tab
    }
  }
  return null
}

/** A tab no session holds yet (a renderer that hasn't saved it) keeps the terminal route. */
export function podSurfaceFocusChannel(
  sessions: PodUiHostSessionSource | null,
  worktreeId: string,
  tabId: string
): 'ui:focusTerminal' | 'ui:focusEditorTab' {
  const tab = sessions ? findSurfaceTab(sessions, worktreeId, tabId) : null
  return tab && tab.contentType !== 'terminal' ? 'ui:focusEditorTab' : 'ui:focusTerminal'
}
