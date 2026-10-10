// Fork-only (Pod): Pod Workspace as runtime RPC (repos under ~/pod, git profile, tidy, adopt).
import { defineMethod } from '../../runtime/rpc/core'
import {
  PodWorkspaceAdoptParams,
  PodWorkspaceCloneDestinationParams,
  PodWorkspaceGitProfileParams,
  PodWorkspaceStatusParams,
  PodWorkspaceTidyApplyParams,
  PodWorkspaceTidyScanParams
} from '../../../shared/rpc-contract/pod-workspace-params'
import { getPodWorkspaceRpcService, type PodWorkspaceRpcService } from './workspace-rpc-service'

function service(): PodWorkspaceRpcService {
  const value = getPodWorkspaceRpcService()
  if (!value?.isEnabled()) {
    throw new Error('Pod Workspace is off in this build.')
  }
  return value
}

// Why workspace for most: they act on the repos and worktrees this runtime manages, like
// worktree.rm. Adopt moves folders on disk outside them, so it needs host-admin.
export const POD_WORKSPACE_METHODS = [
  defineMethod({
    name: 'podWorkspace.enabled',
    permission: 'workspace',
    params: null,
    handler: () => ({ enabled: getPodWorkspaceRpcService()?.isEnabled() === true })
  }),
  defineMethod({
    name: 'podWorkspace.status',
    permission: 'workspace',
    params: PodWorkspaceStatusParams,
    handler: (params) => service().status(params.refresh === true)
  }),
  defineMethod({
    name: 'podWorkspace.tidyScan',
    permission: 'workspace',
    params: PodWorkspaceTidyScanParams,
    handler: (params) => service().tidyScan(params.repoIds)
  }),
  defineMethod({
    name: 'podWorkspace.tidyApply',
    permission: 'workspace',
    params: PodWorkspaceTidyApplyParams,
    handler: (params, { runtime }) =>
      service().tidyApply(params.action, async (worktreeId) => {
        // Not forced: the archive already proved the worktree clean.
        await runtime.removeManagedWorktree(`id:${worktreeId}`, { waitForBackgroundRemoval: true })
      })
  }),
  defineMethod({
    name: 'podWorkspace.gitProfile',
    permission: 'workspace',
    params: PodWorkspaceGitProfileParams,
    handler: (params) => service().gitProfile(params.repoId, params.action)
  }),
  defineMethod({
    name: 'podWorkspace.cloneDestination',
    permission: 'workspace',
    params: PodWorkspaceCloneDestinationParams,
    handler: async (params) => ({ destination: await service().cloneDestination(params.url) })
  }),
  defineMethod({
    name: 'podWorkspace.adopt',
    permission: 'host-admin',
    params: PodWorkspaceAdoptParams,
    handler: (params) => service().adopt(params.action)
  })
]
