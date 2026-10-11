// Fork-only (Pod): `files.openDiff` (Source Control's diff, `orca open --diff`) on the headless
// one-app runtime. A window keeps diff tabs only in its renderer, never in the session, so this
// runtime keeps them in memory: the headless projection lists them after the worktree's files
// (`type: 'file', mode: 'diff'`), PodNative's native diff shows them, and a close retires them.
import type { RuntimeMobileSessionFileTab } from '../../../shared/runtime-types'
import type { RuntimeNavigationTarget } from '../../../shared/runtime-navigation'
import { navigationTargetsHost } from '../../../shared/runtime-navigation'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { isPodHeadlessUiHost } from './pod-ui-host-launch'

type DiffTab = { id: string; filePath: string; relativePath: string; staged: boolean; active: boolean }

type DiffTabHost = {
  getWorkspaceSessionForWorktree(worktreeId: string): WorkspaceSessionState | null | undefined
  hydrateHeadlessMobileSessionTabsFromWorkspaceSession(
    worktreeId: string,
    options: { force: true }
  ): unknown
  notifyMobileSessionTabsChanged(worktreeId: string): void
}

const diffTabsByWorktree = new Map<string, DiffTab[]>()

/** The renderer's id for a Source Control diff tab (editor-open-diff), staged and unstaged apart. */
export function headlessDiffTabId(worktreeId: string, relativePath: string, staged: boolean): string {
  return `${worktreeId}::diff::${staged ? 'staged' : 'unstaged'}::${relativePath}`
}

/** True when the headless one-app runtime opened it; false leaves the caller's renderer_unavailable. */
export function openPodHeadlessDiffTab(
  host: DiffTabHost,
  worktreeId: string,
  filePath: string,
  relativePath: string,
  staged: boolean,
  navigation: RuntimeNavigationTarget | undefined
): boolean {
  // The projection lists only worktrees with a session, as for files.open.
  if (!isPodHeadlessUiHost() || !host.getWorkspaceSessionForWorktree(worktreeId)) {
    return false
  }
  const id = headlessDiffTabId(worktreeId, relativePath, staged)
  // `caller` leaves the active tab alone, as files.open does.
  const activate = navigationTargetsHost(navigation ?? 'all')
  const tabs = (diffTabsByWorktree.get(worktreeId) ?? []).map((tab) =>
    activate ? { ...tab, active: tab.id === id } : tab
  )
  if (!tabs.some((tab) => tab.id === id)) {
    tabs.push({ id, filePath, relativePath, staged, active: activate })
  }
  diffTabsByWorktree.set(worktreeId, tabs)
  host.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId, { force: true })
  host.notifyMobileSessionTabsChanged(worktreeId)
  return true
}

/** The worktree's diff tabs as the headless projection lists them. */
export function listPodHeadlessDiffTabs(worktreeId: string): RuntimeMobileSessionFileTab[] {
  return (diffTabsByWorktree.get(worktreeId) ?? []).map((tab) => ({
    type: 'file',
    id: tab.id,
    title: tab.relativePath.split(/[\\/]/).pop() || tab.relativePath,
    filePath: tab.filePath,
    relativePath: tab.relativePath,
    language: 'plaintext',
    mode: 'diff',
    diffSource: tab.staged ? 'staged' : 'unstaged',
    isDirty: false,
    isActive: tab.active,
    color: null,
    isPinned: false
  }))
}

/** A file tab became the active one: no diff tab stays active beside it. */
export function deactivatePodHeadlessDiffTabs(worktreeId: string): void {
  const tabs = diffTabsByWorktree.get(worktreeId)
  if (tabs) {
    diffTabsByWorktree.set(
      worktreeId,
      tabs.map((tab) => ({ ...tab, active: false }))
    )
  }
}

/** True when the tab was one of them (now gone); the caller republishes. */
export function removePodHeadlessDiffTab(worktreeId: string, tabId: string): boolean {
  const tabs = diffTabsByWorktree.get(worktreeId) ?? []
  const rest = tabs.filter((tab) => tab.id !== tabId)
  if (rest.length === tabs.length) {
    return false
  }
  if (rest.length > 0) {
    diffTabsByWorktree.set(worktreeId, rest)
  } else {
    diffTabsByWorktree.delete(worktreeId)
  }
  return true
}
