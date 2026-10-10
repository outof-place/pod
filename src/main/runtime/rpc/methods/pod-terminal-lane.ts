// Fork-only (Pod): grants PodNative a direct terminal lane for one of its multiplex streams on this
// local stream connection (pod-terminal-lanes.ts). Refused with POD_TERMINAL_DIRECT_LANE=0.
import { PodTerminalDirectLaneParams } from '../../../../shared/rpc-contract/pod-terminal-lane-params'
import { defineMethod } from '../core'
import { grantPodTerminalLane } from '../../pod-lane/pod-terminal-lanes'

export const POD_TERMINAL_LANE_METHODS = [
  defineMethod({
    name: 'pod.terminal.directLane',
    permission: 'workspace',
    params: PodTerminalDirectLaneParams,
    handler: (params, { connectionId }) => grantPodTerminalLane(connectionId, params.streamId)
  })
]
