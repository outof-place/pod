import type {
  PodWorkspaceExcludeResult,
  PodWorkspaceRootValidation,
  PodWorkspaceStatus
} from '../../shared/pod-workspace-types'

/** Fork-only (Pod, macOS): the workspace root and its health checks. */
export type PodWorkspaceApi = {
  isEnabled: () => Promise<boolean>
  /** null while the workspace is off. */
  getStatus: (args?: { refresh?: boolean }) => Promise<PodWorkspaceStatus | null>
  validateRoot: (root: string) => Promise<PodWorkspaceRootValidation>
  excludeBuildFolders: () => Promise<PodWorkspaceExcludeResult | null>
  openSpotlightSettings: () => Promise<boolean>
  /** Parent folder for a clone of `url`; null keeps Orca's default. */
  getCloneDestination: (url: string) => Promise<string | null>
}
