import type { PodWorkspaceRootValidation } from '../../shared/pod-workspace-types'

/** Fork-only (Pod, macOS): the workspace root. */
export type PodWorkspaceApi = {
  isEnabled: () => Promise<boolean>
  validateRoot: (root: string) => Promise<PodWorkspaceRootValidation>
  /** Parent folder for a clone of `url`; null keeps Orca's default. */
  getCloneDestination: (url: string) => Promise<string | null>
}
