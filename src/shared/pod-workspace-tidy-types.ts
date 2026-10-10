// Fork-only (Pod): worktree tidying, git profile and adoption, as the runtime reports them.
import type { PodGitProfileRow } from './pod-workspace-git-profile'

export type PodWorkspaceGitProfile = {
  repoPath: string
  rows: PodGitProfileRow[]
  trackedFiles: number | null
  packCount: number | null
  partialClone: boolean
  maintenanceRegistered: boolean
  /** Pod registered it, so a revert unregisters it. */
  podRegisteredMaintenance: boolean
  applied: number
  pending: number
}

/** Why a worktree is probably safe to tidy. */
export type PodTidyReason = 'merged' | 'upstream-gone' | 'stale' | 'prunable' | 'idle-watcher'

/** Why tidying it now would lose something or disturb someone. */
export type PodTidyBlocker =
  | 'main-worktree'
  | 'locked'
  | 'dirty'
  | 'unpushed'
  | 'process-inside'
  | 'git-error'

export type PodTidyProcess = { pid: number; name: string }

export type PodTidyWorktree = {
  repoId: string
  /** Orca's worktree id (`repoId::path`). */
  worktreeId: string
  path: string
  branch: string | null
  head: string | null
  isMain: boolean
  reasons: PodTidyReason[]
  blockers: PodTidyBlocker[]
  /** Newest of the index, HEAD and HEAD reflog mtimes; 0 when none could be read. */
  lastActivityAt: number
  /** Commits on the branch that its upstream lacks; null without an upstream. */
  ahead: number | null
  dirtyCount: number | null
  processes: PodTidyProcess[]
  fsmonitorRunning: boolean
}

/** A folder in a repo's worktree directory that no worktree registration names. */
export type PodTidyStrayFolder = { repoId: string; path: string; modifiedAt: number }

export type PodTidyArchive = {
  id: string
  repoId: string
  repoPath: string
  path: string
  branch: string | null
  head: string
  /** `refs/pod/archive/...`: keeps the commits reachable after the worktree is gone. */
  ref: string
  archivedAt: number
}

export type PodTidyScan = {
  scannedAt: number
  worktrees: PodTidyWorktree[]
  strayFolders: PodTidyStrayFolder[]
  /** Per repo: registrations whose folder is gone, as `git worktree prune --dry-run` names them. */
  prunable: { repoId: string; names: string[] }[]
  archives: PodTidyArchive[]
  errors: { repoId: string; message: string }[]
}

export type PodTidyAction =
  | { kind: 'archive'; worktreeId: string }
  | { kind: 'restore'; archiveId: string }
  | { kind: 'forget'; archiveId: string }
  | { kind: 'prune'; repoId: string }
  | { kind: 'trash-stray'; repoId: string; path: string }
  | { kind: 'stop-watcher'; worktreeId: string }

export type PodTidyResult = {
  ok: boolean
  /** What changed, for the undo toast. */
  message: string
  archive?: PodTidyArchive
  pruned?: string[]
}

export type PodAdoptBlocker =
  | 'not-a-repo'
  | 'already-inside'
  | 'target-exists'
  | 'other-volume'
  | 'process-inside'

export type PodAdoptPlan = {
  repoId: string
  from: string
  to: string
  blockers: PodAdoptBlocker[]
  processes: PodTidyProcess[]
  /** Linked worktrees git must repair after the move. */
  linkedWorktrees: string[]
  /** `<repo>.worktrees/`, which moves along when it exists. */
  worktreesDir: string | null
  claudeProjectDir: string | null
}

export type PodAdoptRecord = {
  id: string
  repoId: string
  from: string
  to: string
  movedAt: number
  worktreesDirMoved: boolean
  claudeProjectDirMoved: boolean
}
