import '../unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import { isStreamingMethod, type RpcContext, type RpcRequest, type RpcResponse } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import {
  publishPodSshPortEvent,
  setPodSshPortForwardOps,
  type PodSshPortForwardOps
} from '../../../pod/ssh/pod-ssh-port-forwards'
import { POD_RUNTIME_CAPABILITIES } from '../../../../shared/pod-runtime-capabilities'
import { POD_SSH_NOT_CONNECTED_CODE } from '../../../../shared/pod-ssh-port-events'
import type { PortForwardEntry } from '../../../../shared/ssh-types'
import { POD_SSH_PORT_FORWARD_METHODS } from './pod-ssh-port-forwards'

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

const forward: PortForwardEntry = {
  id: 'fwd-1',
  connectionId: 'ssh-1',
  localPort: 5173,
  remoteHost: 'localhost',
  remotePort: 5173,
  label: 'vite'
}
const input = { targetId: 'ssh-1', localPort: 5173, remoteHost: 'localhost', remotePort: 5173 }

function installOps(overrides: Partial<PodSshPortForwardOps> = {}) {
  const ops = {
    list: vi.fn<PodSshPortForwardOps['list']>(() => [forward]),
    add: vi.fn<PodSshPortForwardOps['add']>(async () => forward),
    update: vi.fn<PodSshPortForwardOps['update']>(async () => forward),
    remove: vi.fn<PodSshPortForwardOps['remove']>(async () => forward),
    listDetected: vi.fn<PodSshPortForwardOps['listDetected']>(() => [
      { port: 3000, host: '127.0.0.1' }
    ])
  }
  setPodSshPortForwardOps({ ...ops, ...overrides })
  return ops
}

function dispatch(
  method: string,
  params?: unknown,
  options?: { pairedDeviceId?: string; connectionId?: string }
): Promise<RpcResponse> {
  const request: RpcRequest = { id: 'req-1', authToken: 'tok', method, params }
  return new RpcDispatcher({ runtime, methods: POD_SSH_PORT_FORWARD_METHODS }).dispatch(
    request,
    options
  )
}

afterEach(() => {
  for (const id of [...cleanups.keys()]) {
    cleanupSubscription(id)
  }
  setPodSshPortForwardOps(null)
  vi.clearAllMocks()
})

describe('Pod SSH port forward RPC methods', () => {
  it('is advertised and host-admin throughout', () => {
    expect(POD_RUNTIME_CAPABILITIES).toContain('pod.ssh.port-forwards.v1')
    expect(POD_SSH_PORT_FORWARD_METHODS.every((method) => method.permission === 'host-admin')).toBe(
      true
    )
  })

  it('lists, adds, edits and removes through the desktop operations', async () => {
    const ops = installOps()

    await expect(dispatch('ssh.listPortForwards', { targetId: 'ssh-1' })).resolves.toMatchObject({
      ok: true,
      result: { forwards: [forward] }
    })
    await expect(dispatch('ssh.listPortForwards')).resolves.toMatchObject({ ok: true })
    await expect(
      dispatch('ssh.addPortForward', { ...input, label: ' vite ' })
    ).resolves.toMatchObject({ ok: true, result: { forward } })
    await expect(
      dispatch('ssh.updatePortForward', { id: 'fwd-1', ...input, localPort: 5174 })
    ).resolves.toMatchObject({ ok: true, result: { forward } })
    await expect(dispatch('ssh.removePortForward', { id: 'fwd-1' })).resolves.toMatchObject({
      ok: true,
      result: { removed: forward }
    })
    await expect(dispatch('ssh.listDetectedPorts', { targetId: 'ssh-1' })).resolves.toMatchObject({
      ok: true,
      result: { ports: [{ port: 3000, host: '127.0.0.1' }] }
    })

    expect(ops.list.mock.calls).toEqual([['ssh-1'], [undefined]])
    expect(ops.add).toHaveBeenCalledWith({ ...input, label: 'vite' })
    expect(ops.update).toHaveBeenCalledWith({ id: 'fwd-1', ...input, localPort: 5174 })
    expect(ops.remove).toHaveBeenCalledWith('fwd-1')
    expect(ops.listDetected).toHaveBeenCalledWith('ssh-1')
  })

  it('names a host that is not connected with its own code', async () => {
    installOps({
      add: vi.fn(async () => {
        throw Object.assign(new Error('SSH connection "ssh-1" not found'), {
          code: POD_SSH_NOT_CONNECTED_CODE
        })
      })
    })

    await expect(dispatch('ssh.addPortForward', input)).resolves.toMatchObject({
      ok: false,
      error: { code: 'ssh_not_connected', message: 'SSH connection "ssh-1" not found' }
    })
  })

  it('answers runtime_unavailable on a host whose SSH layer never registered', async () => {
    await expect(dispatch('ssh.listPortForwards', {})).resolves.toMatchObject({
      ok: false,
      error: { message: 'runtime_unavailable' }
    })
  })

  it.each([
    ['ssh.addPortForward', { ...input, localPort: 0 }],
    ['ssh.addPortForward', { ...input, remotePort: 70_000 }],
    ['ssh.addPortForward', { ...input, remoteHost: ' ' }],
    ['ssh.addPortForward', { ...input, extra: true }],
    ['ssh.updatePortForward', input],
    ['ssh.removePortForward', {}],
    ['ssh.listDetectedPorts', {}]
  ])('refuses malformed %s params %j', async (method, params) => {
    const ops = installOps()

    await expect(dispatch(method, params)).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_argument' }
    })
    expect(ops.add).not.toHaveBeenCalled()
    expect(ops.update).not.toHaveBeenCalled()
  })

  it("keeps forwards away from paired devices and SSH hosts' CLIs", async () => {
    const ops = installOps()
    const bridge = new RpcDispatcher({
      runtime,
      methods: POD_SSH_PORT_FORWARD_METHODS,
      callerScope: { kind: 'ssh-bridge', targetId: 'ssh-1', remoteCliControl: true }
    })

    for (const [method, params] of [
      ['ssh.listPortForwards', {}],
      ['ssh.addPortForward', input]
    ] as const) {
      await expect(dispatch(method, params, { pairedDeviceId: 'phone-1' })).resolves.toMatchObject({
        ok: false,
        error: { code: 'forbidden' }
      })
      await expect(
        bridge.dispatch({ id: 'req-1', authToken: 'tok', method, params })
      ).resolves.toMatchObject({ ok: false, error: { code: 'forbidden' } })
    }
    expect(ops.list).not.toHaveBeenCalled()
    expect(ops.add).not.toHaveBeenCalled()
  })

  it('streams ready, then the changes, until unsubscribed', async () => {
    const method = POD_SSH_PORT_FORWARD_METHODS.find(
      (entry) => entry.name === 'ssh.ports.subscribe'
    )
    if (!method || !isStreamingMethod(method)) {
      throw new Error('missing ssh.ports.subscribe')
    }
    const frames: Record<string, unknown>[] = []
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only these fields.
    const context = { runtime, connectionId: 'conn-1', caller: { kind: 'local-cli' } } as RpcContext
    const done = method.handler(null, context, (frame) => {
      frames.push(frame as Record<string, unknown>)
    })

    publishPodSshPortEvent(() => ({
      type: 'sshPortForwardsChanged',
      targetId: 'ssh-1',
      forwards: [forward]
    }))
    const subscriptionId = String(frames[0]?.subscriptionId)
    await expect(
      dispatch('ssh.ports.unsubscribe', { subscriptionId }, { connectionId: 'conn-1' })
    ).resolves.toMatchObject({
      ok: true,
      result: { unsubscribed: true }
    })
    await done
    publishPodSshPortEvent(() => ({
      type: 'sshDetectedPortsChanged',
      targetId: 'ssh-1',
      ports: []
    }))

    expect(frames).toEqual([
      { type: 'ready', subscriptionId: expect.stringMatching(/^pod-ssh-ports-conn-1-/) },
      { type: 'sshPortForwardsChanged', targetId: 'ssh-1', forwards: [forward] },
      { type: 'end' }
    ])
  })
})
