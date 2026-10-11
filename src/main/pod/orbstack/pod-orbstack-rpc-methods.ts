// Fork-only (Pod): OrbStack as runtime RPC, so the renderer, the CLI and the native shell share one API.
import { defineMethod, defineStreamingMethod } from '../../runtime/rpc/core'
import {
  PodOrbstackAgentSandboxParams,
  PodOrbstackCreateParams,
  PodOrbstackDockerPinParams,
  PodOrbstackMachineParams,
  PodOrbstackSandboxClaudeLoginParams,
  PodOrbstackStatsParams,
  PodOrbstackStatusParams,
  PodOrbstackTemplatesParams,
  PodOrbstackUnsubscribeParams,
  PodOrbstackWorktreeParams
} from '../../../shared/rpc-contract/pod-orbstack-params'
import { getPodOrbstackService, type PodOrbstackService } from './pod-orbstack-service'

function service(): PodOrbstackService {
  const value = getPodOrbstackService()
  if (!value?.isEnabled()) {
    throw new Error('OrbStack support is off in this build.')
  }
  return value
}

// Per process, so two subscribes in one millisecond never share a cleanup id.
let subscriptionSeq = 0

// Why host-admin: these list and change Linux machines on this Mac, not Orca workspace state.
export const POD_ORBSTACK_METHODS = [
  defineMethod({
    name: 'orbstack.enabled',
    permission: 'host-admin',
    params: null,
    handler: () => ({ enabled: getPodOrbstackService()?.isEnabled() === true })
  }),
  defineMethod({
    name: 'orbstack.status',
    permission: 'host-admin',
    params: PodOrbstackStatusParams,
    handler: (params) => service().snapshot({ containers: params.containers })
  }),
  defineMethod({
    name: 'orbstack.machines',
    permission: 'host-admin',
    params: null,
    handler: async () => {
      const { machines, errors } = await service().snapshot()
      return { machines, errors }
    }
  }),
  defineMethod({
    name: 'orbstack.containers',
    permission: 'host-admin',
    params: null,
    handler: async () => {
      const { containers, errors } = await service().snapshot()
      return { containers, errors }
    }
  }),
  defineMethod({
    name: 'orbstack.create',
    permission: 'host-admin',
    params: PodOrbstackCreateParams,
    handler: (params) => service().create(params)
  }),
  defineMethod({
    name: 'orbstack.start',
    permission: 'host-admin',
    params: PodOrbstackMachineParams,
    handler: (params) => service().start(params.name)
  }),
  defineMethod({
    name: 'orbstack.stop',
    permission: 'host-admin',
    params: PodOrbstackMachineParams,
    handler: (params) => service().stop(params.name)
  }),
  defineMethod({
    name: 'orbstack.delete',
    permission: 'host-admin',
    params: PodOrbstackWorktreeParams,
    handler: (params) => service().remove(params.worktreeId, params.kind)
  }),
  defineMethod({
    name: 'orbstack.pinDocker',
    permission: 'host-admin',
    params: PodOrbstackDockerPinParams,
    handler: (params) => service().setDockerPin(params.worktreeId, params.pinned)
  }),
  defineMethod({
    name: 'orbstack.setAgentSandbox',
    permission: 'host-admin',
    params: PodOrbstackAgentSandboxParams,
    handler: (params) => service().setAgentSandbox(params.worktreeId, params.enabled)
  }),
  defineMethod({
    name: 'orbstack.setSandboxClaudeLogin',
    permission: 'host-admin',
    params: PodOrbstackSandboxClaudeLoginParams,
    handler: (params) => service().setSandboxClaudeLogin(params.enabled)
  }),
  defineMethod({
    name: 'orbstack.setTemplates',
    permission: 'host-admin',
    params: PodOrbstackTemplatesParams,
    handler: (params) => service().setTemplates(params.enabled)
  }),
  // Why no params and no confirmation here: it stops every running container and machine on the
  // Mac, so each client asks the user first, with what is running.
  defineMethod({
    name: 'orbstack.restart',
    permission: 'host-admin',
    params: null,
    handler: () => service().restart()
  }),
  // Why on demand: each tick runs one `orb run` per running Pod machine. A client polls it only
  // while its OrbStack panel is visible and the app is active; ticks are at most every 2 s and
  // shared, so two clients cost what one does.
  defineMethod({
    name: 'orbstack.stats',
    permission: 'host-admin',
    params: PodOrbstackStatsParams,
    handler: (params) => service().stats(params.names)
  }),
  defineStreamingMethod({
    name: 'orbstack.subscribe',
    permission: 'host-admin',
    params: null,
    handler: async (_params, { runtime, connectionId }, emit) => {
      const events = service()
      await new Promise<void>((resolve) => {
        const subscriptionId = `orbstack-${connectionId ?? 'inproc'}-${++subscriptionSeq}`
        const { seed, stop } = events.subscribe(emit)
        runtime.registerSubscriptionCleanup(
          subscriptionId,
          () => {
            stop()
            emit({ type: 'end' })
            resolve()
          },
          connectionId
        )
        emit({ type: 'ready', subscriptionId, relay: seed })
      })
    }
  }),
  defineMethod({
    name: 'orbstack.unsubscribe',
    permission: 'host-admin',
    params: PodOrbstackUnsubscribeParams,
    handler: (params, { runtime }) => {
      runtime.cleanupSubscription(params.subscriptionId)
      return { unsubscribed: true }
    }
  })
]
