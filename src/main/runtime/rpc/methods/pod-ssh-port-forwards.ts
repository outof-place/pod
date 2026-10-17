// Fork-only (Pod): SSH port forwarding for PodNative: list, add, edit and remove forwards, the ports
// a host's relay detects, and a stream of their changes. Same operations as the desktop's
// ssh:*PortForward* IPC (ssh-port-forward-handlers.ts). host-admin, unlike a clientEvents opt-in,
// which an SSH host's orca CLI may subscribe to.
import {
  getPodSshPortForwardOps,
  subscribePodSshPortEvents,
  type PodSshPortForwardOps
} from '../../../pod/ssh/pod-ssh-port-forwards'
import { defineMethod, defineStreamingMethod, type RpcContext } from '../core'
import {
  SshAddPortForwardParams,
  SshListDetectedPortsParams,
  SshListPortForwardsParams,
  SshPortsUnsubscribeParams,
  SshRemovePortForwardParams,
  SshUpdatePortForwardParams
} from '../../../../shared/rpc-contract/pod-ssh-port-forward-params'
import { assertLocalRpcCaller } from './pod-local-caller'

function ops(ctx: RpcContext, method: string): PodSshPortForwardOps {
  assertLocalRpcCaller(ctx, method)
  const installed = getPodSshPortForwardOps()
  if (!installed) {
    throw new Error('runtime_unavailable')
  }
  return installed
}

let subscriptionSeq = 0

function subscriptionPrefix(connectionId: string | undefined): string {
  return `pod-ssh-ports-${connectionId ?? 'inproc'}-`
}

export const POD_SSH_PORT_FORWARD_METHODS = [
  defineMethod({
    name: 'ssh.listPortForwards',
    permission: 'host-admin',
    params: SshListPortForwardsParams,
    handler: (params, ctx) => ({
      forwards: ops(ctx, 'ssh.listPortForwards').list(params?.targetId)
    })
  }),
  defineMethod({
    name: 'ssh.addPortForward',
    permission: 'host-admin',
    params: SshAddPortForwardParams,
    handler: async (params, ctx) => ({
      forward: await ops(ctx, 'ssh.addPortForward').add(params)
    })
  }),
  defineMethod({
    name: 'ssh.updatePortForward',
    permission: 'host-admin',
    params: SshUpdatePortForwardParams,
    handler: async (params, ctx) => ({
      forward: await ops(ctx, 'ssh.updatePortForward').update(params)
    })
  }),
  defineMethod({
    name: 'ssh.removePortForward',
    permission: 'host-admin',
    params: SshRemovePortForwardParams,
    handler: async (params, ctx) => ({
      removed: await ops(ctx, 'ssh.removePortForward').remove(params.id)
    })
  }),
  defineMethod({
    name: 'ssh.listDetectedPorts',
    permission: 'host-admin',
    params: SshListDetectedPortsParams,
    handler: (params, ctx) => ({
      ports: ops(ctx, 'ssh.listDetectedPorts').listDetected(params.targetId)
    })
  }),
  defineStreamingMethod({
    name: 'ssh.ports.subscribe',
    permission: 'host-admin',
    params: null,
    handler: async (_params, ctx, emit) => {
      assertLocalRpcCaller(ctx, 'ssh.ports.subscribe')
      const { runtime, connectionId } = ctx
      const subscriptionId = `${subscriptionPrefix(connectionId)}${++subscriptionSeq}`
      await new Promise<void>((resolve) => {
        let stop: (() => void) | null = null
        runtime.registerSubscriptionCleanup(
          subscriptionId,
          () => {
            stop?.()
            emit({ type: 'end' })
            resolve()
          },
          connectionId
        )
        emit({ type: 'ready', subscriptionId })
        // Changes only: a client lists the forwards and detected ports it shows after `ready`.
        stop = subscribePodSshPortEvents(emit)
      })
    }
  }),
  defineMethod({
    name: 'ssh.ports.unsubscribe',
    permission: 'host-admin',
    params: SshPortsUnsubscribeParams,
    handler: (params, ctx) => {
      assertLocalRpcCaller(ctx, 'ssh.ports.unsubscribe')
      if (!params.subscriptionId.startsWith(subscriptionPrefix(ctx.connectionId))) {
        return { unsubscribed: false }
      }
      ctx.runtime.cleanupSubscription(params.subscriptionId)
      return { unsubscribed: true }
    }
  })
]
