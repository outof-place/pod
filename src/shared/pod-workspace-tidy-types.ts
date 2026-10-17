// Fork-only (Pod): worktree tidying, git profile and adoption, as the runtime reports them.
// Every change is two calls: a plan (scan) that returns a planId, and an apply that names it.
import type { PodGitProfileRow } from './pod-workspace-git-profile'

/** A plan the runtime holds for one apply; a changed fingerprint or an expired id is refused. */
export type PodWorkspacePlanRef = { planId: string; expiresAt: number }

/** Why a worktree is probably safe to tidy. */
export type PodTidyReason =
  | 'merged'
  /** The base has the branch's changes but not its commits: a squash or rebase merge. */
  | 'squash-merged'
  | 'upstream-gone'
  | 'stale'
  | 'prunable'
  | 'idle-watcher'

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
  /** What followed the folders; absent on a record from a Pod that moved the folders alone. */
  relink?: PodAdoptRelinkRecord
  /**
   * Written before the first rename and after each step: `moving` (folders on the way),
   * `moved` (folders and git links done), `relinked` (Pod's records too). Absent on older records.
   */
  progress?: 'moving' | 'moved' | 'relinked'
  /** The repo folder itself moved; false in a record written before its rename landed. */
  repoMoved?: boolean
  /**
   * The rename under way when this was written: after a crash in it, Move Back looks for that
   * folder in both places, and skips it where it never left.
   */
  renaming?: 'repo' | 'worktrees'
  /** `git worktree repair` failed after the move: what git said. Move Back still works. */
  repairError?: string
}

/** A value git keeps as an absolute path into the moved folders, as Move In rewrote it. */
export type PodAdoptConfigPath = {
  /** `local`: the repo's own config; `global`: `maintenance.repo` in the user's. */
  scope: 'local' | 'global'
  key: string
  from: string
  to: string
}

/** What Move In carries to the new path besides the folders, each pair as `[before, after]`. */
export type PodAdoptRelinkRecord = {
  /** The repo row's path before the move (Pod may know the repo by a symlinked spelling). */
  repoPath: string
  repoPathAfter: string
  /** Orca's worktree ids, re-keyed so sidebar state, tabs and lineage stay with each worktree. */
  worktreeIds: [string, string][]
  /** Claude Code project folders renamed for each checkout; the old name stays as a link. */
  claudeProjectDirs: [string, string][]
  /** Per-worktree shell history folders under the profile's `terminal-history/`. */
  historyDirs: [string, string][]
  configPaths: PodAdoptConfigPath[]
  /** OrbStack docker pins and sandbox-by-default flags re-keyed to the new worktree ids. */
  orbstackKeys?: [string, string][]
}

/** What a Move In would carry along, so the plan shows every change before the user applies it. */
export type PodAdoptRelinkPlan = {
  /** Checkout paths, before and after: the repo itself and each worktree that moves with it. */
  worktrees: [string, string][]
  claudeProjectDirs: [string, string][]
  historyDirs: number
  configPaths: PodAdoptConfigPath[]
  /** Worktrees with a live Pod terminal: Close Terminals first, so no running pane is re-keyed. */
  terminalsOpen: string[]
  /** OrbStack machines whose mounts name these folders: Pod can't carry them, so it refuses. */
  orbstackMachines: string[]
  /** Other Pod projects inside the folders that would move with them unrecorded: refused. */
  nestedProjects: string[]
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
export type PodProfileOptInId =
  | 'reftable'
  | 'many-files'
  | 'bitmaps'
  | 'backfill'
  | 'relative-worktrees'

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
  /** What relative-worktrees found, so undo puts the repository format back as it was. */
  relativeWorktreesBefore?: { extension: string | null; formatVersion: string | null }
  /** Median `git status` before this apply, for verify's before/after; null when unmeasured. */
  statusMsBefore?: number | null
}

/** One verify check: what Pod looked at, whether it holds, and what it saw. */
export type PodGitProfileCheck = {
  id: 'keys' | 'fsmonitor' | 'maintenance' | 'scheduler'
  ok: boolean
  detail: string
}

/** A read-only look at whether the applied profile is in effect, with `git status` timed now. */
export type PodGitProfileVerify = {
  repoPath: string
  checks: PodGitProfileCheck[]
  statusMs: number | null
  /** The newest apply's measurement, so the UI can show before and after. */
  statusMsBefore: number | null
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
  | 'files-open'
  | 'terminals-open'
  | 'orbstack-machines'
  | 'nested-project'
  /** The repo holds the workspace root itself (a repo at `~`, say): it can't move into it. */
  | 'contains-root'

/** Soft: the user may tick these; every other adopt blocker refuses. */
export type PodAdoptSoftBlocker = 'process-inside' | 'files-open'

/** A file a process holds open inside a folder Move In would rename. */
export type PodAdoptOpenFile = { pid: number; name: string; path: string }

/** What applying would change beyond Pod's own records, shown before the user applies. */
export type PodAdoptWarning =
  /** The Compose project is named after the folder, so it gets a new name and empty volumes. */
  | { kind: 'compose-project'; file: string; from: string; to: string }
  /** Claude Code starts these checkouts afresh: trust, allowed tools and local MCP are by path. */
  | { kind: 'claude-trust'; count: number }
  /** Automations that run in one of these worktrees name its old id: they need pointing again. */
  | { kind: 'automations'; names: string[] }

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
  relink: PodAdoptRelinkPlan
  /** Up to 20 of the open files behind `files-open`. */
  openFiles: PodAdoptOpenFile[]
  /** False where this Pod's process addon can't list open files: nothing was checked. */
  openFilesChecked: boolean
  warnings: PodAdoptWarning[]
}

export type PodAdoptUndoPlan = PodWorkspacePlanRef & {
  record: PodAdoptRecord
  blockers: ('process-inside' | 'link-changed' | 'terminals-open')[]
  processes: PodTidyProcess[]
}
