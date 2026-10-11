// Fork-only (Pod): `files.open` (what `orca open` and agents call) on the headless one-app runtime.
// No window holds editor tabs there, so the tab goes into the host's own session as the renderer
// persists it (id = entityId = filePath, in the worktree's group), the headless projection lists it,
// and PodNative's native editor shows and edits it. A window opened later hydrates that same tab.
// Plain `serve` keeps answering renderer_unavailable.
import type { RuntimeNavigationTarget } from '../../../shared/runtime-navigation'
import { navigationTargetsHost } from '../../../shared/runtime-navigation'
import type { Tab } from '../../../shared/tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { HeadlessEditorRetirementHost } from '../../runtime/mobile-session-editor-projection'
import { isMobileMarkdownPath } from '../../runtime/runtime-file-command-host'
import { isPodHeadlessUiHost } from './pod-ui-host-launch'

type EditorFile = { filePath: string; relativePath: string }

/** The session with the file's editor tab open (and active when `activate`); unchanged ids. */
export function addHeadlessEditorTab(
  session: WorkspaceSessionState,
  worktreeId: string,
  file: EditorFile,
  activate: boolean,
  now: number
): WorkspaceSessionState {
  const files = session.openFilesByWorktree?.[worktreeId] ?? []
  const openFiles = files.some((open) => open.filePath === file.filePath)
    ? files
    : [
        ...files,
        {
          filePath: file.filePath,
          relativePath: file.relativePath,
          worktreeId,
          // The projection tells markdown from text by this; a window re-detects it on hydrate.
          language: isMobileMarkdownPath(file.relativePath) ? 'markdown' : 'plaintext'
        }
      ]
  const tabs = session.unifiedTabs?.[worktreeId] ?? []
  const groups = session.tabGroups?.[worktreeId] ?? []
  const existing = tabs.find(
    (tab) => tab.contentType === 'editor' && tab.entityId === file.filePath
  )
  // Without a group (no window ever laid this worktree out) the renderer's reconciliation makes the tab.
  const group = groups.find((candidate) => candidate.id === existing?.groupId) ?? groups[0]
  const unifiedTab: Tab | null =
    existing ??
    (group
      ? {
          id: file.filePath,
          entityId: file.filePath,
          groupId: group.id,
          worktreeId,
          contentType: 'editor',
          label: file.relativePath.split(/[\\/]/).pop() || file.relativePath,
          customLabel: null,
          color: null,
          sortOrder: tabs.length,
          createdAt: now
        }
      : null)
  return {
    ...session,
    openFilesByWorktree: { ...session.openFilesByWorktree, [worktreeId]: openFiles },
    ...(unifiedTab && !existing
      ? { unifiedTabs: { ...session.unifiedTabs, [worktreeId]: [...tabs, unifiedTab] } }
      : {}),
    ...(unifiedTab && group
      ? {
          tabGroups: {
            ...session.tabGroups,
            [worktreeId]: groups.map((candidate) =>
              candidate.id !== group.id
                ? candidate
                : {
                    ...candidate,
                    tabOrder: candidate.tabOrder.includes(unifiedTab.id)
                      ? candidate.tabOrder
                      : [...candidate.tabOrder, unifiedTab.id],
                    ...(activate ? { activeTabId: unifiedTab.id } : {})
                  }
            )
          }
        }
      : {}),
    ...(activate
      ? {
          activeFileIdByWorktree: {
            ...session.activeFileIdByWorktree,
            [worktreeId]: file.filePath
          },
          activeTabTypeByWorktree: { ...session.activeTabTypeByWorktree, [worktreeId]: 'editor' }
        }
      : {})
  }
}

/** True when the headless one-app runtime opened it; false leaves the caller's renderer_unavailable. */
export function openPodHeadlessEditorTab(
  host: Pick<
    HeadlessEditorRetirementHost,
    | 'getWorkspaceSessionForWorktree'
    | 'setWorkspaceSessionForWorktree'
    | 'hydrateHeadlessMobileSessionTabsFromWorkspaceSession'
    | 'notifyMobileSessionTabsChanged'
  >,
  worktreeId: string,
  filePath: string,
  relativePath: string,
  navigation: RuntimeNavigationTarget | undefined,
  now: number = Date.now()
): boolean {
  if (!isPodHeadlessUiHost()) {
    return false
  }
  const session = host.getWorkspaceSessionForWorktree(worktreeId)
  if (!session) {
    return false
  }
  // `caller` leaves the active tab alone. Otherwise the tab becomes the worktree's active one, as a
  // window would show it, without taking the screen (a window doesn't either).
  const toHost = navigationTargetsHost(navigation ?? 'all')
  host.setWorkspaceSessionForWorktree(
    worktreeId,
    addHeadlessEditorTab(session, worktreeId, { filePath, relativePath }, toHost, now)
  )
  host.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId, { force: true })
  host.notifyMobileSessionTabsChanged(worktreeId)
  return true
}
