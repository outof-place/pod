// Fork-only (Pod): SSH settings' host list, Add, Save, Remove, ~/.ssh/config sync and Disconnect,
// for PodNative's SSH Hosts pane. Same operations as the desktop's SSH IPC (ssh-target-crud-handlers.ts).
import { getRegisteredSshState, listRegisteredSshTargets } from '../../../ssh/ssh-target-registry'
import {
  buildSshTargetSettingsPayload,
  getPodSshTargetSettingsOps,
  toSshTargetConfig,
  type PodSshTargetSettingsOps
} from '../../../pod/ssh/pod-ssh-target-settings'
import { defineMethod, type RpcContext } from '../core'
import { getPublicSshError, getPublicSshState } from '../../public-ssh-state'
import { SshTarget } from '../../../../shared/rpc-contract/ssh-params'
import {
  SshAddTargetParams,
  SshImportConfigParams,
  SshUpdateTargetParams
} from '../../../../shared/rpc-contract/pod-ssh-target-params'
import type { SshRepoReadoption } from '../../../../shared/ssh-types'
import { assertLocalRpcCaller } from './pod-local-caller'

function ops(): PodSshTargetSettingsOps {
  const installed = getPodSshTargetSettingsOps()
  if (!installed) {
    throw new Error('runtime_unavailable')
  }
  return installed
}

/** Settings ops: this machine's callers only, since paired clients see no SSH addresses. */
function localOps(ctx: RpcContext, method: string): PodSshTargetSettingsOps {
  assertLocalRpcCaller(ctx, method)
  return ops()
}

// Why: the desktop refreshes its repo list on `repos:changed`; RPC clients refetch on this.
function announceReadoptions(ctx: RpcContext, readoptions: SshRepoReadoption[]): void {
  if (readoptions.length === 0) {
    return
  }
  try {
    ctx.runtime.notifyReposChangedForRemoteClients()
  } catch (error) {
    console.error('[ssh] failed to notify clients of re-adopted workspaces', error)
  }
}

export const POD_SSH_TARGET_METHODS = [
  defineMethod({
    name: 'ssh.listTargetConfigs',
    permission: 'host-admin',
    params: null,
    handler: (_params, ctx) => {
      localOps(ctx, 'ssh.listTargetConfigs')
      return { targets: listRegisteredSshTargets().map(toSshTargetConfig) }
    }
  }),
  defineMethod({
    name: 'ssh.addTarget',
    permission: 'host-admin',
    params: SshAddTargetParams,
    handler: (params, ctx) => {
      const { target, repoReadoptions } = localOps(ctx, 'ssh.addTarget').add(
        buildSshTargetSettingsPayload(params.target).target
      )
      announceReadoptions(ctx, repoReadoptions)
      return { target: toSshTargetConfig(target), repoReadoptions }
    }
  }),
  defineMethod({
    name: 'ssh.updateTarget',
    permission: 'host-admin',
    params: SshUpdateTargetParams,
    handler: (params, ctx) => {
      const updated = localOps(ctx, 'ssh.updateTarget').update(
        params.targetId,
        buildSshTargetSettingsPayload(params.target).updates
      )
      return { target: updated ? toSshTargetConfig(updated) : null }
    }
  }),
  defineMethod({
    name: 'ssh.removeTarget',
    permission: 'host-admin',
    params: SshTarget,
    handler: async (params, ctx) => {
      await localOps(ctx, 'ssh.removeTarget').remove(params.targetId)
      return { removed: true as const }
    }
  }),
  defineMethod({
    name: 'ssh.importConfig',
    permission: 'host-admin',
    params: SshImportConfigParams,
    handler: (params, ctx) => {
      const { targets, repoReadoptions } = localOps(ctx, 'ssh.importConfig').importConfig({
        reAdopt: params.reAdopt
      })
      announceReadoptions(ctx, repoReadoptions)
      return { targets: targets.map(toSshTargetConfig), repoReadoptions }
    }
  }),
  // Why paired clients may: it is ssh.connect's counterpart and reveals nothing about the host.
  defineMethod({
    name: 'ssh.disconnect',
    permission: 'host-admin',
    params: SshTarget,
    handler: async (params) => {
      const installed = ops()
      try {
        await installed.disconnect(params.targetId)
      } catch {
        throw new Error(
          getPublicSshError(getRegisteredSshState(params.targetId)?.status ?? 'error')
        )
      }
      return { state: getPublicSshState(getRegisteredSshState(params.targetId) ?? null) }
    }
  })
]
