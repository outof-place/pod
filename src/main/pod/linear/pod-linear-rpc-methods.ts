// Fork-only (Pod): linear.setEnabled and linear.setAgentAccess. Admission lets only Pod's window and
// PodNative reach them (pod-linear-access.ts); linear.status reads both back.
import { defineMethod } from '../../runtime/rpc/core'
import {
  PodLinearSetAgentAccessParams,
  PodLinearSetEnabledParams
} from '../../../shared/rpc-contract/pod-linear-params'
import {
  POD_LINEAR_SET_AGENT_ACCESS,
  POD_LINEAR_SET_ENABLED,
  writePodLinearAgentAccess
} from './pod-linear-access'
import { podLinearAvailability, writePodLinearEnabled } from './pod-linear-availability'

export const POD_LINEAR_METHODS = [
  defineMethod({
    name: POD_LINEAR_SET_ENABLED,
    permission: 'accounts-admin',
    params: PodLinearSetEnabledParams,
    handler: (params) => {
      const enabled = writePodLinearEnabled(params.enabled)
      const availability = podLinearAvailability()
      return { enabled, ...availability }
    }
  }),
  defineMethod({
    name: POD_LINEAR_SET_AGENT_ACCESS,
    permission: 'accounts-admin',
    params: PodLinearSetAgentAccessParams,
    handler: (params) => ({ agentAccess: writePodLinearAgentAccess(params.enabled) })
  })
]
