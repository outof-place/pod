import { describe, expect, it } from 'vitest'
import { MOBILE_RPC_METHOD_ALLOWLIST } from './runtime-rpc/runtime-rpc-mobile-method-allowlist'

const MOBILE_STREAMING_CLEANUP_RPC_METHODS = [
  // Why: shared-control unsubscribe methods are sent from generated cleanup
  // paths, so literal mobile source scanning cannot discover every one.
  'accounts.unsubscribe',
  'browser.screencast.unsubscribe',
  'notifications.unsubscribe',
  'runtime.clientEvents.unsubscribe',
  'session.tabs.unsubscribe',
  'session.tabs.unsubscribeAll',
  'terminal.unsubscribe'
]

function mobileRpcAllowlist(): ReadonlySet<string> {
  return MOBILE_RPC_METHOD_ALLOWLIST
}

describe('mobile RPC allowlist', () => {
  it('allows every cleanup RPC for mobile streaming subscriptions', () => {
    const allowed = mobileRpcAllowlist()
    const missing = MOBILE_STREAMING_CLEANUP_RPC_METHODS.filter((method) => !allowed.has(method))

    expect(missing).toEqual([])
  })

  it('does not grant mobile credentials control over host updates', () => {
    const allowed = mobileRpcAllowlist()
    expect(
      ['updater.getStatus', 'updater.check', 'updater.download', 'updater.install'].filter(
        (method) => allowed.has(method)
      )
    ).toEqual([])
  })

  it('exposes only the mobile structured agent-session surface', () => {
    expect(
      [...mobileRpcAllowlist()].filter((method) => method.startsWith('agentSession.'))
    ).toEqual([
      'agentSession.createSupport',
      'agentSession.create',
      'agentSession.ensure',
      'agentSession.reveal',
      'agentSession.send',
      'agentSession.cancel',
      'agentSession.queuedMessageSend',
      'agentSession.queuedMessageDelete',
      'agentSession.queuedMessageUpdate',
      'agentSession.queuedMessageEditHold',
      'agentSession.queuedMessagesResume',
      'agentSession.close',
      'agentSession.respondToApproval',
      'agentSession.respondToQuestion',
      'agentSession.setOption',
      'agentSession.handoffStatus',
      'agentSession.options',
      'agentSession.modelCatalog',
      'agentSession.conversationCommand',
      'agentSession.commands',
      'agentSession.history',
      'agentSession.subscribe',
      'agentSession.unsubscribe',
      'agentSession.subscribeStatus',
      'agentSession.readVisual',
      'agentSession.hold',
      'agentSession.release'
    ])
    expect(mobileRpcAllowlist().has('agentSession.attach')).toBe(false)
  })
})
