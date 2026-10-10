// Fork-only (Pod): worktree tidying, git profile and adoption, as the runtime reports them.
// Every change is two calls: a plan (scan) that returns a planId, and an apply that names it.
import type { PodGitProfileRow } from './pod-workspace-git-profile'

/** A plan the runtime holds for one apply; a changed fingerprint or an expired id is refused. */
export type PodWorkspacePlanRef = { planId: string; expiresAt: number }

/** Why a worktree is probably safe to tidy. */
export type PodTidyReason = 'merged' | 'upstream-gone' | 'stale' | 'prunable' | 'idle-watcher'

/** Always refused. */
export type PodTidyHardBlocker = 'main-worktree' | 'locked' | 'git-error'
/** Refused unless the plan lists it and the user ticks it. */
export type PodSoftBlocker = 'dirty' | 'unpushed' | 'process-inside'
export type PodTidyBlocker = PodTidyHardBlocker | PodSoftBlocker

export const POD_SOFT_BLOCKERS: readonly PodSoftBlocker[] = ['dirty', 'unpushed', 'process-inside']

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
  /** What an apply checks again; any change since the scan refuses it. */
  fingerprint: string
}

/** A folder in a worktree root (Orca's, or Pod's `<repo>.worktrees/`) that git doesn't name. */
export type PodTidyStrayFolder = {
  repoId: string
  path: string
  modifiedAt: number
  fingerprint: string
}

export type PodTidyArchive = {
  id: string
  repoId: string
  repoPath: string
  path: string
  branch: string | null
  head: string
  /** `refs/pod/archive/...`: keeps the commits reachable after the worktree is gone. */
  ref: string
  /** Where the folder went in the Trash, untracked and ignored files included; null if unknown. */
  trashedPath: string | null
  archivedAt: number
}

/** A stray folder Pod moved to the Trash, so Put Back knows where it came from. */
export type PodTidyTrashed = {
  id: string
  repoId: string
  path: string
  trashedPath: string
  trashedAt: number
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

export type PodTidyScan = PodWorkspacePlanRef & {
  scannedAt: number
  worktrees: PodTidyWorktree[]
  strayFolders: PodTidyStrayFolder[]
  /** Per repo: registrations whose folder is gone, as `git worktree list` marks them prunable. */
  prunable: { repoId: string; paths: string[] }[]
  archives: PodTidyArchive[]
  trashed: PodTidyTrashed[]
  /** Moves into the root that can still be undone. */
  adoptions: PodAdoptRecord[]
  errors: { repoId: string; message: string }[]
}

export type PodTidyAction =
  | { kind: 'archive'; worktreeId: string }
  | { kind: 'restore'; archiveId: string }
  | { kind: 'forget'; archiveId: string }
  | { kind: 'prune'; repoId: string }
  | { kind: 'trash-stray'; repoId: string; path: string }
  | { kind: 'put-back'; trashedId: string }
  | { kind: 'stop-watcher'; worktreeId: string }

export type PodTidyResult = {
  ok: boolean
  /** What changed, for the undo toast. */
  message: string
  /** The action that takes this one back, against a fresh scan. */
  undo?: PodTidyAction
  pruned?: string[]
}

/** An opt-in in the git profile: off by default because it measured no win, or costs a download. */
export type PodProfileOptInId = 'reftable' | 'many-files' | 'bitmaps' | 'backfill'

export type PodProfileOptIn = {
  id: PodProfileOptInId
  available: boolean
  /** Why not, when unavailable; what it costs or gains, when available. */
  note: string
  /** Already in effect in this repo. */
  active: boolean
  /** Backfill: blobs this blobless clone lacks, and about how many bytes a download takes. */
  estimate?: { missingBlobs: number; bytes: number }
}

/** One apply of the profile, kept so it can be undone key for key. */
export type PodTuneRecord = {
  id: string
  repoId: string
  repoPath: string
  appliedAt: number
  /** Keys Orca's tuning (#27028) set during this apply; its record `orca.performanceConfig`. */
  orcaKeys: string[]
  /** Keys Pod set; its record `pod.workspaceConfig`. */
  podKeys: string[]
  registeredMaintenance: boolean
  optIns: PodProfileOptInId[]
}

export type PodWorkspaceGitProfile = PodWorkspacePlanRef & {
  repoPath: string
  rows: PodGitProfileRow[]
  optIns: PodProfileOptIn[]
  trackedFiles: number | null
  packCount: number | null
  partialClone: boolean
  refFormat: 'files' | 'reftable'
  maintenanceRegistered: boolean
  applied: number
  pending: number
  tunes: PodTuneRecord[]
}

export type PodAdoptBlocker =
  | 'not-a-repo'
  | 'already-inside'
  | 'target-exists'
  | 'other-volume'
  | 'process-inside'

export type PodAdoptPlan = PodWorkspacePlanRef & {
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

export type PodAdoptUndoPlan = PodWorkspacePlanRef & {
  record: PodAdoptRecord
  blockers: ('process-inside' | 'link-changed')[]
  processes: PodTidyProcess[]
}
