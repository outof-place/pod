// Fork-only (Pod): the workspace root and its health snapshot, shared by main, preload and renderer.

/** Used when `podWorkspaceRoot` is unset; `~` is the user's home. */
export const POD_WORKSPACE_DEFAULT_ROOT = '~/pod'

export const POD_WORKSPACE_IPC = {
  enabled: 'pod:workspace:enabled',
  status: 'pod:workspace:status',
  validateRoot: 'pod:workspace:validateRoot',
  excludeBuildFolders: 'pod:workspace:excludeBuildFolders',
  openSpotlightSettings: 'pod:workspace:openSpotlightSettings',
  cloneDestination: 'pod:workspace:cloneDestination'
} as const

export type PodWorkspaceRootIssueCode =
  | 'empty'
  | 'not-absolute'
  | 'not-a-directory'
  | 'icloud-drive'
  | 'icloud-desktop-documents'
  | 'icloud-desktop-documents-unknown'
  | 'documents-desktop-tcc'

export type PodWorkspaceRootIssue = {
  code: PodWorkspaceRootIssueCode
  /** Errors block saving the root; warnings only inform. */
  severity: 'error' | 'warning'
}

export type PodWorkspaceRootValidation = {
  /** Absolute root with `~` expanded; null when the input names none. */
  root: string | null
  issues: PodWorkspaceRootIssue[]
}

export type PodWorkspaceVolumeChecks = {
  pnpmStoreDir: string
  /** null when either volume could not be read. */
  sameVolumeAsPnpmStore: boolean | null
  caseSensitive: boolean | null
  freeBytes: number | null
  totalBytes: number | null
}

export type PodWorkspaceSpotlightState = 'indexed' | 'excluded' | 'unknown'

export type PodWorkspaceSpotlight = {
  state: PodWorkspaceSpotlightState
  /** Why the state is unknown. */
  reason: 'no-old-files' | 'indexing-disabled' | 'error' | null
  checkedAt: number
}

export type PodWorkspaceTimeMachineDestination = 'configured' | 'none' | 'unknown'

export type PodWorkspaceTimeMachine = {
  destination: PodWorkspaceTimeMachineDestination
  excluded: string[]
  missing: string[]
}

/** Values as `git config` reports them; null when unset. */
export type PodWorkspaceGitTuning = {
  untrackedCache: string | null
  fsmonitor: string | null
  indexVersion: string | null
  checkoutWorkers: string | null
  /** Set when Orca applied the tuning itself. */
  orcaPerformanceConfig: string | null
}

/** One worktree as the search index daemon reports it (ogd `status`, per worktree). */
export type PodWorkspaceIndexStatus = {
  /** ogd reports `building`, `ready` or `failed`. */
  state: string
  docs: number
  generation: number
  settled: boolean
  buildMs: number
}

export type PodWorkspaceRepoRow = {
  repoId: string
  path: string
  displayName: string
  branch: string | null
  worktreeCount: number | null
  gitTuning: PodWorkspaceGitTuning | null
  /** null when the index does not hold this repo, or no index is connected. */
  index: PodWorkspaceIndexStatus | null
}

export type PodWorkspaceOutsideRepo = {
  repoId: string
  path: string
  displayName: string
}

export type PodWorkspaceStatus = {
  root: string
  /** `root` and, when it differs, its real path; repo paths may use either. */
  rootAliases: string[]
  rootExists: boolean
  validation: PodWorkspaceRootValidation
  volume: PodWorkspaceVolumeChecks
  spotlight: PodWorkspaceSpotlight
  timeMachine: PodWorkspaceTimeMachine
  indexConnected: boolean
  repos: PodWorkspaceRepoRow[]
  outsideRepos: PodWorkspaceOutsideRepo[]
  migrationScript: { path: string; exists: boolean }
  generatedAt: number
}

export type PodWorkspaceExcludeResult = {
  excluded: number
  failed: string[]
  destination: PodWorkspaceTimeMachineDestination
}
