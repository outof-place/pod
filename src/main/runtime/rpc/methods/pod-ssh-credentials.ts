// Fork-only (Pod): SSH connect prompts (passphrase, password, keyboard-interactive) for PodNative,
// the desktop's ssh:credential-request and ssh:submitCredential (pod-ssh-credential-hub.ts).
// host-admin, unlike clientEvents' opt-ins: an SSH host's orca CLI may subscribe to those.
import { podSshCredentialHub } from '../../../pod/ssh/pod-ssh-credential-hub'
import { defineMethod, defineStreamingMethod } from '../core'
import {
  SshCredentialPromptsUnsubscribeParams,
  SshSubmitCredentialParams
} from '../../../../shared/rpc-contract/pod-ssh-credential-params'
import { assertLocalRpcCaller } from './pod-local-caller'

let subscriptionSeq = 0

function subscriptionPrefix(connectionId: string | undefined): string {
  return `pod-ssh-credential-prompts-${connectionId ?? 'inproc'}-`
}

export const POD_SSH_CREDENTIAL_METHODS = [
  defineStreamingMethod({
    name: 'ssh.credentialPrompts.subscribe',
    permission: 'host-admin',
    params: null,
    handler: async (_params, ctx, emit) => {
      assertLocalRpcCaller(ctx, 'ssh.credentialPrompts.subscribe')
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
        // Why after ready: the prompts already open follow it, and nothing can open in between.
        stop = podSshCredentialHub.subscribe(emit)
      })
    }
  }),
  defineMethod({
    name: 'ssh.credentialPrompts.unsubscribe',
    permission: 'host-admin',
    params: SshCredentialPromptsUnsubscribeParams,
    handler: (params, ctx) => {
      assertLocalRpcCaller(ctx, 'ssh.credentialPrompts.unsubscribe')
      if (!params.subscriptionId.startsWith(subscriptionPrefix(ctx.connectionId))) {
        return { unsubscribed: false }
      }
      ctx.runtime.cleanupSubscription(params.subscriptionId)
      return { unsubscribed: true }
    }
  }),
  defineMethod({
    name: 'ssh.submitCredential',
    permission: 'host-admin',
    params: SshSubmitCredentialParams,
    handler: (params, ctx) => {
      assertLocalRpcCaller(ctx, 'ssh.submitCredential')
      // false: the prompt already settled (answered elsewhere, cancelled or timed out).
      return { accepted: podSshCredentialHub.submit(params.requestId, params.value) }
    }
  })
]
