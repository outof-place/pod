// Fork-only (Pod): the last Computer Use actions as a stream, for the native Computer Use pane.
import { defineMethod, defineStreamingMethod } from '../../runtime/rpc/core'
import { PodComputerActionsUnsubscribeParams } from '../../../shared/rpc-contract/pod-computer-actions-params'
import { podComputerActionLog, type PodComputerActionLog } from './pod-computer-actions'

// Per process, so two subscribes in one millisecond never share a cleanup id.
let subscriptionSeq = 0

function enabledLog(log: PodComputerActionLog): PodComputerActionLog {
  if (!log.enabled()) {
    throw new Error('Computer Use actions are not reported in this build.')
  }
  return log
}

// Why desktop-control: the rows tell which apps agents operated, like the actions themselves; a
// paired client gets it only when granted at pairing, phones and SSH hosts never.
export function createPodComputerActionsMethods(log: PodComputerActionLog = podComputerActionLog) {
  return [
    defineStreamingMethod({
      name: 'computer.actions',
      permission: 'desktop-control',
      params: null,
      handler: async (_params, { runtime, connectionId }, emit) => {
        const actions = enabledLog(log)
        await new Promise<void>((resolve) => {
          const subscriptionId = `computer-actions-${connectionId ?? 'inproc'}-${++subscriptionSeq}`
          const { seed, stop } = actions.subscribe(emit)
          runtime.registerSubscriptionCleanup(
            subscriptionId,
            () => {
              stop()
              emit({ type: 'end' })
              resolve()
            },
            connectionId
          )
          emit({ type: 'ready', subscriptionId, actions: seed })
        })
      }
    }),
    defineMethod({
      name: 'computer.unsubscribeActions',
      permission: 'desktop-control',
      params: PodComputerActionsUnsubscribeParams,
      handler: (params, { runtime }) => {
        runtime.cleanupSubscription(params.subscriptionId)
        return { unsubscribed: true }
      }
    })
  ]
}

export const POD_COMPUTER_ACTIONS_METHODS = createPodComputerActionsMethods()
