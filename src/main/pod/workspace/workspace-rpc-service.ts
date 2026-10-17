// Fork-only (Pod): the workspace service behind `podWorkspace.*` runtime RPC, so the renderer,
// the CLI and the native shell share one API.
import type { z } from 'zod'
import type {
  PodWorkspaceExcludeResult,
  PodWorkspaceRootValidation,
  PodWorkspaceSetRootResult,
  PodWorkspaceStatusReply
} from '../../../shared/pod-workspace-types'
import type {
  PodAdoptPlan,
  PodGitProfileVerify,
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
import type { AdoptRelinkRuntime } from './workspace-adopt-relink'
import type { PodTuneResult } from './workspace-git-profile'
import type { WorkspaceTidyRequest } from './workspace-tidy-actions'

export type PodWorkspaceGitProfileRequest = z.infer<typeof PodWorkspaceGitProfileParams>
export type PodWorkspaceAdoptRequest = z.infer<typeof PodWorkspaceAdoptParams>

export type PodWorkspaceRpcService = {
  isEnabled(): boolean
  status(refresh: boolean): Promise<PodWorkspaceStatusReply>
  validateRoot(value: string): Promise<PodWorkspaceRootValidation>
  /** Saves the root after the same checks validateRoot runs; nothing moves (Move In is per repo). */
  setRoot(value: string | null): Promise<PodWorkspaceSetRootResult>
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
  ): Promise<PodWorkspaceGitProfile | PodTuneResult | PodGitProfileVerify>
  /** `runtime` lists live terminals and tells clients about re-keyed worktrees and repos. */
  adopt(
    request: PodWorkspaceAdoptRequest,
    runtime: AdoptRelinkRuntime | null
  ): Promise<PodAdoptPlan | PodAdoptRecord | PodAdoptUndoPlan>
}

let service: PodWorkspaceRpcService | null = null

export function setPodWorkspaceRpcService(value: PodWorkspaceRpcService | null): void {
  service = value
}

export function getPodWorkspaceRpcService(): PodWorkspaceRpcService | null {
  return service
}
