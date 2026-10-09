// Fork-only (Pod): the workspace root, shared by main, preload and renderer.

/** Used when `podWorkspaceRoot` is unset; `~` is the user's home. */
export const POD_WORKSPACE_DEFAULT_ROOT = '~/pod'

export const POD_WORKSPACE_IPC = {
  enabled: 'pod:workspace:enabled',
  validateRoot: 'pod:workspace:validateRoot',
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

/** One worktree as the search index daemon reports it (ogd `status`, per worktree). */
export type PodWorkspaceIndexStatus = {
  /** ogd reports `building`, `ready` or `failed`. */
  state: string
  docs: number
  generation: number
  settled: boolean
  buildMs: number
}
