// Fork-only (Pod): the workspace service behind `podWorkspace.*` runtime RPC, so the renderer,
// the CLI and the native shell share one API.
import type { PodWorkspaceStatus } from '../../../shared/pod-workspace-types'
import type {
  PodAdoptPlan,
  PodAdoptRecord,
  PodTidyAction,
  PodTidyResult,
  PodTidyScan,
  PodWorkspaceGitProfile
} from '../../../shared/pod-workspace-tidy-types'
import type { PodGitProfileRow } from '../../../shared/pod-workspace-git-profile'

export type PodWorkspaceAdoptAction =
  | { kind: 'plan'; repoId: string }
  | { kind: 'apply'; repoId: string }
  | { kind: 'undo'; recordId: string }

export type PodWorkspaceGitProfileResult =
  | { profile: PodWorkspaceGitProfile | null }
  | { written: PodGitProfileRow[]; profile: PodWorkspaceGitProfile | null }
  | { removed: string[]; profile: PodWorkspaceGitProfile | null }

export type PodWorkspaceRpcService = {
  isEnabled(): boolean
  status(refresh: boolean): Promise<PodWorkspaceStatus>
  tidyScan(repoIds: readonly string[] | undefined): Promise<PodTidyScan>
  /** `removeWorktree` is the caller's runtime removal, so Orca tears the worktree down itself. */
  tidyApply(
    action: PodTidyAction,
    removeWorktree: (worktreeId: string) => Promise<void>
  ): Promise<PodTidyResult>
  gitProfile(
    repoId: string,
    action: 'plan' | 'apply' | 'revert'
  ): Promise<PodWorkspaceGitProfileResult>
  cloneDestination(url: string): Promise<string | null>
  adopt(action: PodWorkspaceAdoptAction): Promise<PodAdoptPlan | PodAdoptRecord>
}

let service: PodWorkspaceRpcService | null = null

export function setPodWorkspaceRpcService(value: PodWorkspaceRpcService | null): void {
  service = value
}

export function getPodWorkspaceRpcService(): PodWorkspaceRpcService | null {
  return service
}
