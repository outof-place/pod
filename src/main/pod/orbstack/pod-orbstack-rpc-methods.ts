// Fork-only (Pod): OrbStack as runtime RPC, so the renderer, the CLI and the native shell share one API.
import { defineMethod } from '../../runtime/rpc/core'
import {
  PodOrbstackCreateParams,
  PodOrbstackDockerPinParams,
  PodOrbstackMachineParams,
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
    params: null,
    handler: () => service().snapshot()
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
    handler: (params) => service().remove(params.worktreeId)
  }),
  defineMethod({
    name: 'orbstack.pinDocker',
    permission: 'host-admin',
    params: PodOrbstackDockerPinParams,
    handler: (params) => service().setDockerPin(params.worktreeId, params.pinned)
  })
]
