import '../unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import { isStreamingMethod, type RpcContext, type RpcRequest, type RpcResponse } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { podSshCredentialHub } from '../../../pod/ssh/pod-ssh-credential-hub'
import { POD_RUNTIME_CAPABILITIES } from '../../../../shared/pod-runtime-capabilities'
import type { PodSshCredentialRequest } from '../../../../shared/pod-ssh-credential-event'
import { POD_SSH_CREDENTIAL_METHODS } from './pod-ssh-credentials'

const cleanups = new Map<string, () => void>()
const cleanupSubscription = vi.fn((id: string) => {
  cleanups.get(id)?.()
  cleanups.delete(id)
})
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers use only the subscription hooks.
const runtime = {
  getRuntimeId: () => 'test-runtime',
  registerSubscriptionCleanup: (id: string, cleanup: () => void) => cleanups.set(id, cleanup),
  cleanupSubscription
} as unknown as OrcaRuntimeService

const prompt = (requestId: string): PodSshCredentialRequest => ({
  requestId,
  targetId: 'ssh-1',
  kind: 'password',
  detail: 'me@dev.internal',
  expiresAtMs: 1_000
})

function dispatch(
  method: string,
  params?: unknown,
  options?: { pairedDeviceId?: string; connectionId?: string }
): Promise<RpcResponse> {
  const request: RpcRequest = { id: 'req-1', authToken: 'tok', method, params }
  return new RpcDispatcher({ runtime, methods: POD_SSH_CREDENTIAL_METHODS }).dispatch(
    request,
    options
  )
}

function subscribe(caller: RpcContext['caller'] = { kind: 'local-cli' }) {
  const method = POD_SSH_CREDENTIAL_METHODS.find(
    (entry) => entry.name === 'ssh.credentialPrompts.subscribe'
  )
  if (!method || !isStreamingMethod(method)) {
    throw new Error('missing ssh.credentialPrompts.subscribe')
  }
  const frames: Record<string, unknown>[] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only these fields.
  const context = { runtime, connectionId: 'conn-1', caller } as RpcContext
  const done = method.handler(null, context, (frame) => {
    frames.push(frame as Record<string, unknown>)
  })
  return { frames, done }
}

const open: string[] = []
function ask(requestId: string, answer: (value: string | null) => void = vi.fn()) {
  open.push(requestId)
  return podSshCredentialHub.ask(prompt(requestId), answer)
}

afterEach(() => {
  for (const requestId of open.splice(0)) {
    podSshCredentialHub.settle(requestId, 'cancelled')
  }
  for (const id of [...cleanups.keys()]) {
    cleanupSubscription(id)
  }
  vi.clearAllMocks()
})

describe('Pod SSH credential prompt RPC methods', () => {
  it('is advertised, so a client connects a host that asks only where it can answer', () => {
    expect(POD_RUNTIME_CAPABILITIES).toContain('pod.ssh.credential-prompts.v1')
  })

  it('declares host-admin on every method', () => {
    expect(POD_SSH_CREDENTIAL_METHODS.map((method) => [method.name, method.permission])).toEqual([
      ['ssh.credentialPrompts.subscribe', 'host-admin'],
      ['ssh.credentialPrompts.unsubscribe', 'host-admin'],
      ['ssh.submitCredential', 'host-admin']
    ])
  })

  it('streams ready, the prompts already open, then new ones and their settlement', async () => {
    ask('open-before')
    const { frames, done } = subscribe()
    expect(ask('opened-after')).toBe(true)
    podSshCredentialHub.settle('open-before', 'submitted')

    expect(frames).toEqual([
      {
        type: 'ready',
        subscriptionId: expect.stringMatching(/^pod-ssh-credential-prompts-conn-1-/)
      },
      { type: 'sshCredentialRequested', ...prompt('open-before') },
      { type: 'sshCredentialRequested', ...prompt('opened-after') },
      { type: 'sshCredentialResolved', requestId: 'open-before', reason: 'submitted' }
    ])

    const subscriptionId = String(frames[0]?.subscriptionId)
    await expect(
      dispatch('ssh.credentialPrompts.unsubscribe', { subscriptionId }, { connectionId: 'conn-1' })
    ).resolves.toMatchObject({ ok: true, result: { unsubscribed: true } })
    await done
    expect(frames.at(-1)).toEqual({ type: 'end' })
    expect(ask('after-end')).toBe(false)
  })

  it("does not end another connection's subscription", async () => {
    await expect(
      dispatch('ssh.credentialPrompts.unsubscribe', {
        subscriptionId: 'pod-ssh-credential-prompts-other-1'
      })
    ).resolves.toMatchObject({ ok: true, result: { unsubscribed: false } })
    expect(cleanupSubscription).not.toHaveBeenCalled()
  })

  it('answers the open prompt, and says when it already settled', async () => {
    const answer = vi.fn()
    ask('req-a', answer)

    await expect(
      dispatch('ssh.submitCredential', { requestId: 'req-a', value: 'secret' })
    ).resolves.toMatchObject({ ok: true, result: { accepted: true } })
    await expect(
      dispatch('ssh.submitCredential', { requestId: 'gone', value: null })
    ).resolves.toMatchObject({ ok: true, result: { accepted: false } })
    expect(answer.mock.calls).toEqual([['secret']])
  })

  it('refuses malformed answers', async () => {
    for (const params of [
      { requestId: '', value: 'x' },
      { requestId: 'req-a' },
      { requestId: 'req-a', value: 'x'.repeat(65_537) },
      { requestId: 'req-a', value: 'x', extra: true }
    ]) {
      await expect(dispatch('ssh.submitCredential', params)).resolves.toMatchObject({
        ok: false,
        error: { code: 'invalid_argument' }
      })
    }
  })

  it("keeps prompts and answers away from paired devices and SSH hosts' CLIs", async () => {
    const answer = vi.fn()
    ask('req-a', answer)
    const bridge = new RpcDispatcher({
      runtime,
      methods: POD_SSH_CREDENTIAL_METHODS,
      callerScope: { kind: 'ssh-bridge', targetId: 'ssh-1', remoteCliControl: true }
    })
    const params = { requestId: 'req-a', value: 'secret' }

    await expect(
      dispatch('ssh.submitCredential', params, { pairedDeviceId: 'phone-1' })
    ).resolves.toMatchObject({ ok: false, error: { code: 'forbidden' } })
    await expect(
      bridge.dispatch({ id: 'req-1', authToken: 'tok', method: 'ssh.submitCredential', params })
    ).resolves.toMatchObject({ ok: false, error: { code: 'forbidden' } })
    await expect(
      subscribe({ kind: 'paired-device', deviceId: 'phone-1' }).done
    ).rejects.toMatchObject({ code: 'forbidden' })
    expect(answer).not.toHaveBeenCalled()
  })

  it('streams through the dispatcher a local stream uses, open prompts with their expiry', async () => {
    ask('open-before')
    const replies: unknown[] = []
    const done = new RpcDispatcher({
      runtime,
      methods: POD_SSH_CREDENTIAL_METHODS
    }).dispatchStreaming(
      { id: 'req-s', authToken: 'tok', method: 'ssh.credentialPrompts.subscribe' },
      (reply) => replies.push(JSON.parse(reply)),
      { connectionId: 'conn-1', caller: { kind: 'local-cli' } }
    )
    await vi.waitFor(() => expect(cleanups.size).toBe(1))
    const text = (): string => JSON.stringify(replies)

    expect(text()).toContain('"sshCredentialRequested"')
    expect(text()).toContain('"expiresAtMs":1000')
    for (const id of [...cleanups.keys()]) {
      cleanupSubscription(id)
    }
    await done
    expect(text()).toContain('"end"')
  })
})
