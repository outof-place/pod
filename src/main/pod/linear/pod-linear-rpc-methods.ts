// Fork-only (Pod): linear.setAgentAccess. Admission lets only Pod's window and PodNative reach it
// (pod-linear-access.ts); linear.status reads the setting back as agentAccess.
import { defineMethod } from '../../runtime/rpc/core'
import { PodLinearSetAgentAccessParams } from '../../../shared/rpc-contract/pod-linear-params'
import { POD_LINEAR_SET_AGENT_ACCESS, writePodLinearAgentAccess } from './pod-linear-access'

export const POD_LINEAR_METHODS = [
  defineMethod({
    name: POD_LINEAR_SET_AGENT_ACCESS,
    permission: 'accounts-admin',
    params: PodLinearSetAgentAccessParams,
    handler: (params) => ({ agentAccess: writePodLinearAgentAccess(params.enabled) })
  })
]
