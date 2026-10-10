// Fork-only (Pod): the workspace service behind `podWorkspace.*` runtime RPC, so the renderer,
// the CLI and the native shell share one API.
import type { z } from 'zod'
import type {
  PodWorkspaceExcludeResult,
  PodWorkspaceRootValidation,
  PodWorkspaceStatusReply
} from '../../../shared/pod-workspace-types'
import type {
  PodAdoptPlan,
  PodAdoptRecord,
  PodAdoptUndoPlan,
  PodTidyResult,
  PodTidyScan,
  PodWorkspaceGitProfile
} from '../../../shared/pod-workspace-tidy-types'
import type {
  PodWorkspaceAdoptParams,
  PodWorkspaceGitProfileParams
} from '../../../shared/rpc-contract/pod-workspace-params'
import type { PodTuneResult } from './workspace-git-profile'
import type { WorkspaceTidyRequest } from './workspace-tidy-actions'

export type PodWorkspaceGitProfileRequest = z.infer<typeof PodWorkspaceGitProfileParams>
export type PodWorkspaceAdoptRequest = z.infer<typeof PodWorkspaceAdoptParams>

export type PodWorkspaceRpcService = {
  isEnabled(): boolean
  status(refresh: boolean): Promise<PodWorkspaceStatusReply>
  validateRoot(value: string): Promise<PodWorkspaceRootValidation>
  excludeBuildFolders(planId: string): Promise<PodWorkspaceExcludeResult>
  openSpotlightSettings(): Promise<boolean>
  cloneDestination(url: string): Promise<string | null>
  tidyScan(repoIds: readonly string[] | undefined): Promise<PodTidyScan>
  /** `removeWorktree` is the caller's runtime removal, so Orca tears the worktree down itself. */
  tidyApply(
    request: WorkspaceTidyRequest,
    removeWorktree: (worktreeId: string) => Promise<void>
  ): Promise<PodTidyResult>
  gitProfile(
    request: PodWorkspaceGitProfileRequest
  ): Promise<PodWorkspaceGitProfile | PodTuneResult>
  adopt(
    request: PodWorkspaceAdoptRequest
  ): Promise<PodAdoptPlan | PodAdoptRecord | PodAdoptUndoPlan>
}

let service: PodWorkspaceRpcService | null = null

export function setPodWorkspaceRpcService(value: PodWorkspaceRpcService | null): void {
  service = value
}

export function getPodWorkspaceRpcService(): PodWorkspaceRpcService | null {
  return service
}
