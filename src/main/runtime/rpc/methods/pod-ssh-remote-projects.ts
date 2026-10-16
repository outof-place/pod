// Fork-only (Pod): Add Project on an SSH host for PodNative: browse the host's folders, then register
// one. Same operations as the desktop's ssh:browseDir (ssh-browse.ts) and repos:addRemote.
import { getPodSshRemoteBrowse } from '../../../pod/ssh/pod-ssh-remote-browse'
import { defineMethod } from '../core'
import { projectRepoVisibilityForClient } from '../repo-visibility-projection'
import {
  RepoAddRemoteParams,
  SshBrowseDirParams
} from '../../../../shared/rpc-contract/pod-ssh-remote-project-params'
import { assertLocalRpcCaller } from './pod-local-caller'

export const POD_SSH_REMOTE_PROJECT_METHODS = [
  defineMethod({
    name: 'ssh.browseDir',
    permission: 'host-admin',
    params: SshBrowseDirParams,
    handler: (params, ctx) => {
      assertLocalRpcCaller(ctx, 'ssh.browseDir')
      const browse = getPodSshRemoteBrowse()
      if (!browse) {
        throw new Error('runtime_unavailable')
      }
      return browse(params.targetId, params.dirPath)
    }
  }),
  defineMethod({
    name: 'repo.addRemote',
    permission: 'host-admin',
    params: RepoAddRemoteParams,
    handler: async (params, ctx) => {
      assertLocalRpcCaller(ctx, 'repo.addRemote')
      const repo = await ctx.runtime.addSshRepo({
        connectionId: params.targetId,
        remotePath: params.remotePath,
        ...(params.displayName ? { displayName: params.displayName } : {}),
        kind: params.kind ?? 'git'
      })
      return { repo: projectRepoVisibilityForClient(repo, ctx) }
    }
  })
]
