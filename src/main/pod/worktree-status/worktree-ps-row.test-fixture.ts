// A worktree.ps row as the runtime sends it, for the worktree-status tests.
import type { RuntimeWorktreePsSummary } from '../../../shared/runtime-types'

export function psRow(
  worktreeId: string,
  status: RuntimeWorktreePsSummary['status'],
  extra: Partial<RuntimeWorktreePsSummary> = {}
): RuntimeWorktreePsSummary {
  return {
    worktreeId,
    repoId: 'repo-1',
    repo: 'app',
    path: `/work/app/${worktreeId}`,
    branch: worktreeId,
    isArchived: false,
    isMainWorktree: false,
    hasHostSidebarActivity: false,
    parentWorktreeId: null,
    childWorktreeIds: [],
    displayName: worktreeId,
    workspaceStatus: 'in-progress',
    sortOrder: 0,
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    comment: '',
    isPinned: false,
    isActive: false,
    unread: false,
    liveTerminalCount: 1,
    hasAttachedPty: true,
    lastOutputAt: null,
    preview: '',
    status,
    agents: [],
    ...extra
  }
}
