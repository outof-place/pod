// Fork-only (Pod): Add Project on an SSH host's nested repository review for PodNative: the
// desktop's projectGroups:scanNested and importNested with a connection (pod-ssh-nested-repos.ts).
import { defineMethod } from '../core'
import {
  ProjectGroupImportNestedRemoteParams,
  ProjectGroupScanNestedRemoteParams
} from '../../../../shared/rpc-contract/pod-ssh-nested-repo-params'
import { assertLocalRpcCaller } from './pod-local-caller'

// Why separate host-admin methods, not a connectionId on projectGroup.scanNested: those hold
// `workspace`, which an SSH host's CLI with remote control on also holds, and a host must not read or
// register another host's folders. The local-caller check refuses any paired device as well; an
// agent's orca CLI in a Pod terminal calls as local-cli like PodNative, and what bounds it is the
// method itself: a configured, connected host only, its folders only, and nothing on this Mac.
export const POD_SSH_NESTED_REPO_METHODS = [
  defineMethod({
    name: 'projectGroup.scanNestedRemote',
    permission: 'host-admin',
    params: ProjectGroupScanNestedRemoteParams,
    handler: (params, ctx) => {
      assertLocalRpcCaller(ctx, 'projectGroup.scanNestedRemote')
      return ctx.runtime.scanNestedReposOnSshHost(params.targetId, params.path)
    }
  }),
  defineMethod({
    name: 'projectGroup.importNestedRemote',
    permission: 'host-admin',
    params: ProjectGroupImportNestedRemoteParams,
    handler: (params, ctx) => {
      assertLocalRpcCaller(ctx, 'projectGroup.importNestedRemote')
      return ctx.runtime.importNestedReposOnSshHost({
        connectionId: params.targetId,
        parentPath: params.parentPath,
        groupName: params.groupName ?? '',
        projectPaths: params.projectPaths,
        mode: params.mode
      })
    }
  })
]
