// Fork-only (Pod): Pod Workspace as runtime RPC (repos under ~/pod, git profile, tidy, adopt).
import { defineMethod } from '../../runtime/rpc/core'
import { POD_WORKSPACE_RPC } from '../../../shared/pod-workspace-types'
import {
  PodWorkspaceAdoptParams,
  PodWorkspaceCloneDestinationParams,
  PodWorkspaceExcludeBuildFoldersParams,
  PodWorkspaceGitProfileParams,
  PodWorkspaceStatusParams,
  PodWorkspaceTidyApplyParams,
  PodWorkspaceTidyScanParams,
  PodWorkspaceUserIntentParams,
  PodWorkspaceValidateRootParams
} from '../../../shared/rpc-contract/pod-workspace-params'
import { getPodWorkspaceRpcService, type PodWorkspaceRpcService } from './workspace-rpc-service'

function service(): PodWorkspaceRpcService {
  const value = getPodWorkspaceRpcService()
  if (!value?.isEnabled()) {
    throw new Error('Pod Workspace is off in this build.')
  }
  return value
}

// Why host-admin: these move, trash and reconfigure folders on this Mac, beyond the worktrees
// a workspace client manages. Every change names the plan its own read handed out.
export const POD_WORKSPACE_METHODS = [
  defineMethod({
    name: POD_WORKSPACE_RPC.enabled,
    permission: 'host-admin',
    params: null,
    handler: () => ({ enabled: getPodWorkspaceRpcService()?.isEnabled() === true })
  }),
  defineMethod({
    name: POD_WORKSPACE_RPC.status,
    permission: 'host-admin',
    params: PodWorkspaceStatusParams,
    handler: (params) => service().status(params.refresh === true)
  }),
  defineMethod({
    name: POD_WORKSPACE_RPC.validateRoot,
    permission: 'host-admin',
    params: PodWorkspaceValidateRootParams,
    handler: (params) => service().validateRoot(params.value)
  }),
  defineMethod({
    name: POD_WORKSPACE_RPC.excludeBuildFolders,
    permission: 'host-admin',
    params: PodWorkspaceExcludeBuildFoldersParams,
    handler: (params) => service().excludeBuildFolders(params.planId)
  }),
  defineMethod({
    name: POD_WORKSPACE_RPC.openSpotlightSettings,
    permission: 'host-admin',
    params: PodWorkspaceUserIntentParams,
    handler: async () => ({ opened: await service().openSpotlightSettings() })
  }),
  defineMethod({
    name: POD_WORKSPACE_RPC.cloneDestination,
    permission: 'host-admin',
    params: PodWorkspaceCloneDestinationParams,
    handler: async (params) => ({ destination: await service().cloneDestination(params.url) })
  }),
  defineMethod({
    name: POD_WORKSPACE_RPC.tidyScan,
    permission: 'host-admin',
    params: PodWorkspaceTidyScanParams,
    handler: (params) => service().tidyScan(params.repoIds)
  }),
  defineMethod({
    name: POD_WORKSPACE_RPC.tidyApply,
    permission: 'host-admin',
    params: PodWorkspaceTidyApplyParams,
    handler: (params, { runtime }) =>
      service().tidyApply(
        { planId: params.planId, action: params.action, acknowledged: params.acknowledged },
        async (worktreeId) => {
          // Not forced: the archive already moved the folder's contents to the Trash.
          await runtime.removeManagedWorktree(`id:${worktreeId}`, {
            waitForBackgroundRemoval: true
          })
        }
      )
  }),
  defineMethod({
    name: POD_WORKSPACE_RPC.gitProfile,
    permission: 'host-admin',
    params: PodWorkspaceGitProfileParams,
    handler: (params) => service().gitProfile(params)
  }),
  defineMethod({
    name: POD_WORKSPACE_RPC.adopt,
    permission: 'host-admin',
    params: PodWorkspaceAdoptParams,
    handler: (params) => service().adopt(params)
  })
]
