import '../unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest, RpcResponse } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { SshTarget } from '../../../../shared/ssh-types'
import {
  setPodSshTargetSettingsOps,
  type PodSshTargetSettingsOps
} from '../../../pod/ssh/pod-ssh-target-settings'
import { POD_RUNTIME_CAPABILITIES } from '../../../../shared/pod-runtime-capabilities'
import { POD_SSH_TARGET_METHODS } from './pod-ssh-targets'

const { listRegisteredSshTargetsMock, getRegisteredSshStateMock } = vi.hoisted(() => ({
  listRegisteredSshTargetsMock: vi.fn(),
  getRegisteredSshStateMock: vi.fn()
}))

vi.mock('../../../ssh/ssh-target-registry', () => ({
  listRegisteredSshTargets: listRegisteredSshTargetsMock,
  getRegisteredSshState: getRegisteredSshStateMock
}))

const notifyReposChangedForRemoteClients = vi.fn()
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers read only the runtime id and the repo-change notifier.
const runtime = {
  getRuntimeId: () => 'test-runtime',
  notifyReposChangedForRemoteClients
} as unknown as OrcaRuntimeService

const stored: SshTarget = {
  id: 'ssh-1',
  label: 'me@dev.internal',
  configHost: 'dev.internal',
  host: 'dev.internal',
  port: 22,
  username: 'me',
  identityFile: '~/.ssh/id_ed25519',
  source: 'manual',
  relayGracePeriodSeconds: 0,
  generation: 3,
  lastRequiredPassphrase: true,
  portForwards: [],
  orcadFence: { environmentId: 'env-1' }
}

function installOps(overrides: Partial<PodSshTargetSettingsOps> = {}) {
  const ops = {
    add: vi.fn<PodSshTargetSettingsOps['add']>(() => ({ target: stored, repoReadoptions: [] })),
    update: vi.fn<PodSshTargetSettingsOps['update']>(() => stored),
    remove: vi.fn<PodSshTargetSettingsOps['remove']>(async () => {}),
    importConfig: vi.fn<PodSshTargetSettingsOps['importConfig']>(() => ({
      targets: [stored],
      repoReadoptions: []
    })),
    disconnect: vi.fn<PodSshTargetSettingsOps['disconnect']>(async () => {})
  }
  setPodSshTargetSettingsOps({ ...ops, ...overrides })
  return ops
}

function dispatch(
  method: string,
  params?: unknown,
  options?: { pairedDeviceId?: string }
): Promise<RpcResponse> {
  const request: RpcRequest = { id: 'req-1', authToken: 'tok', method, params }
  return new RpcDispatcher({ runtime, methods: POD_SSH_TARGET_METHODS }).dispatch(request, options)
}

const form = { host: 'dev.internal', port: 22, username: 'me' }

afterEach(() => {
  setPodSshTargetSettingsOps(null)
  vi.clearAllMocks()
})

describe('Pod SSH settings RPC methods', () => {
  it('is advertised, so a client shows its host editor only where it works', () => {
    expect(POD_RUNTIME_CAPABILITIES).toContain('pod.ssh.target-settings.v1')
  })

  it('declares host-admin on every method', () => {
    expect(POD_SSH_TARGET_METHODS.map((method) => [method.name, method.permission])).toEqual([
      ['ssh.listTargetConfigs', 'host-admin'],
      ['ssh.addTarget', 'host-admin'],
      ['ssh.updateTarget', 'host-admin'],
      ['ssh.removeTarget', 'host-admin'],
      ['ssh.importConfig', 'host-admin'],
      ['ssh.disconnect', 'host-admin']
    ])
  })

  it("refuses an SSH host's orca CLI, even with remote control on, so a remote host cannot edit hosts", async () => {
    const ops = installOps()
    const bridge = new RpcDispatcher({
      runtime,
      methods: POD_SSH_TARGET_METHODS,
      callerScope: { kind: 'ssh-bridge', targetId: 'ssh-1', remoteCliControl: true }
    })

    const response = await bridge.dispatch({
      id: 'req-1',
      authToken: 'tok',
      method: 'ssh.removeTarget',
      params: { targetId: 'ssh-1' }
    })

    expect(response).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(ops.remove).not.toHaveBeenCalled()
  })

  it('validates the form as the settings pane does', async () => {
    installOps()
    const cases: [unknown, string][] = [
      [{ ...form, host: '  ' }, 'Host or SSH config alias is required'],
      [{ ...form, port: 0 }, 'Port must be between 1 and 65535'],
      [{ ...form, port: 70000 }, 'Port must be between 1 and 65535'],
      [{ ...form, relayGracePeriodSeconds: 30 }, 'Terminal timeout must be between 60'],
      [{ ...form, orcadFence: { environmentId: 'forged' } }, 'Unrecognized key']
    ]
    for (const [target, message] of cases) {
      const response = await dispatch('ssh.addTarget', { target })
      expect(response, message).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
      expect(JSON.stringify(response)).toContain(message)
    }
  })

  it('adds the host the pane would store and answers with its editable fields only', async () => {
    const ops = installOps()

    const response = await dispatch('ssh.addTarget', {
      target: { ...form, identityFile: ' ', systemSshConnectionReuse: true, label: '' }
    })

    expect(ops.add).toHaveBeenCalledWith({
      label: 'me@dev.internal',
      configHost: 'dev.internal',
      host: 'dev.internal',
      port: 22,
      username: 'me',
      relayGracePeriodSeconds: 0
    })
    expect(response).toMatchObject({
      ok: true,
      result: { target: { id: 'ssh-1', host: 'dev.internal', managedServer: true } }
    })
    const text = JSON.stringify(response)
    for (const mainOwned of ['orcadFence', 'lastRequiredPassphrase', 'portForwards']) {
      expect(text).not.toContain(mainOwned)
    }
    expect(notifyReposChangedForRemoteClients).not.toHaveBeenCalled()
  })

  it.each(['me@dev.example.com:2222', 'ssh://me@dev.example.com:2222'])(
    'splits %s into user, host and port as the pane does, on add and on save',
    async (host) => {
      const ops = installOps()

      await dispatch('ssh.addTarget', { target: { host, port: 22 } })
      await dispatch('ssh.updateTarget', { targetId: 'ssh-1', target: { host, port: 22 } })

      const expected = {
        label: 'me@dev.example.com',
        configHost: 'dev.example.com',
        host: 'dev.example.com',
        port: 2222,
        username: 'me'
      }
      expect(ops.add).toHaveBeenCalledWith(expect.objectContaining(expected))
      expect(ops.update).toHaveBeenCalledWith('ssh-1', expect.objectContaining(expected))
    }
  )

  it('lets an explicit user or non-default port win over the pasted ones', async () => {
    const ops = installOps()

    await dispatch('ssh.addTarget', {
      target: { host: 'me@dev.example.com:2222', port: 2200, username: 'bob' }
    })

    expect(ops.add).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'dev.example.com', port: 2200, username: 'bob' })
    )
  })

  it.each(['h:99999', 'me@h:0', 'ssh://me@h:99999'])(
    'refuses %s with the pane message and stores nothing',
    async (host) => {
      const ops = installOps()

      const response = await dispatch('ssh.addTarget', { target: { host, port: 22 } })

      expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
      expect(JSON.stringify(response)).toContain('Port must be between 1 and 65535')
      expect(ops.add).not.toHaveBeenCalled()
    }
  )

  it('tells clients when a re-added host took its old workspaces back', async () => {
    const readoption = { oldTargetId: 'ssh-0', newTargetId: 'ssh-1', repoIds: ['repo-1'] }
    installOps({ add: vi.fn(() => ({ target: stored, repoReadoptions: [readoption] })) })

    const response = await dispatch('ssh.addTarget', { target: form })

    expect(response).toMatchObject({ ok: true, result: { repoReadoptions: [readoption] } })
    expect(notifyReposChangedForRemoteClients).toHaveBeenCalledTimes(1)
  })

  it('saves an edit whole, clearing what the form left empty, and marks the host manual', async () => {
    const ops = installOps()

    await dispatch('ssh.updateTarget', {
      targetId: 'ssh-1',
      target: { ...form, identityFile: '', jumpHost: 'bastion', systemSshConnectionReuse: false }
    })

    const [id, updates] = ops.update.mock.calls[0] ?? []
    expect(id).toBe('ssh-1')
    expect(updates).toMatchObject({ jumpHost: 'bastion', systemSshConnectionReuse: false })
    expect(updates).toHaveProperty('source', 'manual')
    // The store merges updates: a cleared field must be present as undefined to be dropped.
    expect(updates).toHaveProperty('identityFile', undefined)
    expect(updates).toHaveProperty('proxyCommand', undefined)
    expect(updates).toHaveProperty('allowRemoteCliControl', undefined)
  })

  it('answers null for a host that is no longer there', async () => {
    installOps({ update: vi.fn(() => null) })
    await expect(
      dispatch('ssh.updateTarget', { targetId: 'gone', target: form })
    ).resolves.toMatchObject({ ok: true, result: { target: null } })
  })

  it('removes, imports and disconnects through the installed operations', async () => {
    const ops = installOps()
    getRegisteredSshStateMock.mockReturnValue({
      targetId: 'ssh-1',
      status: 'disconnected',
      error: null,
      reconnectAttempt: 0
    })

    await expect(dispatch('ssh.removeTarget', { targetId: 'ssh-1' })).resolves.toMatchObject({
      ok: true,
      result: { removed: true }
    })
    await expect(dispatch('ssh.importConfig', { reAdopt: true })).resolves.toMatchObject({
      ok: true,
      result: { targets: [{ id: 'ssh-1' }], repoReadoptions: [] }
    })
    await expect(dispatch('ssh.disconnect', { targetId: 'ssh-1' })).resolves.toMatchObject({
      ok: true,
      result: { state: { status: 'disconnected' } }
    })
    expect(ops.remove).toHaveBeenCalledWith('ssh-1')
    expect(ops.importConfig).toHaveBeenCalledWith({ reAdopt: true })
    expect(ops.disconnect).toHaveBeenCalledWith('ssh-1')
  })

  it('surfaces a refused remove with its reason', async () => {
    installOps({
      remove: vi.fn(async () => {
        throw new Error('This host runs a managed Orca server.')
      })
    })
    await expect(dispatch('ssh.removeTarget', { targetId: 'ssh-1' })).resolves.toMatchObject({
      ok: false,
      error: { message: 'This host runs a managed Orca server.' }
    })
  })

  it('lists every host with its editable fields', async () => {
    installOps()
    listRegisteredSshTargetsMock.mockReturnValue([stored])

    const response = await dispatch('ssh.listTargetConfigs')

    expect(response).toMatchObject({
      ok: true,
      result: { targets: [{ id: 'ssh-1', identityFile: '~/.ssh/id_ed25519', generation: 3 }] }
    })
    expect(JSON.stringify(response)).not.toContain('env-1')
  })

  it("keeps hosts' addresses and edits away from paired devices", async () => {
    const ops = installOps()
    listRegisteredSshTargetsMock.mockReturnValue([stored])
    const paired = { pairedDeviceId: 'phone-1' }
    const calls: [string, unknown][] = [
      ['ssh.listTargetConfigs', undefined],
      ['ssh.addTarget', { target: form }],
      ['ssh.updateTarget', { targetId: 'ssh-1', target: form }],
      ['ssh.removeTarget', { targetId: 'ssh-1' }],
      ['ssh.importConfig', {}]
    ]
    for (const [method, params] of calls) {
      const response = await dispatch(method, params, paired)
      expect(response, method).toMatchObject({ ok: false, error: { code: 'forbidden' } })
      expect(JSON.stringify(response)).not.toContain('dev.internal')
    }
    for (const op of [ops.add, ops.update, ops.remove, ops.importConfig]) {
      expect(op).not.toHaveBeenCalled()
    }
  })

  it('redacts a failed disconnect as connect does', async () => {
    installOps({
      disconnect: vi.fn(async () => {
        throw new Error('identity /Users/hub/.ssh/private via bastion.internal failed')
      })
    })
    getRegisteredSshStateMock.mockReturnValue({ status: 'error' })

    const response = await dispatch(
      'ssh.disconnect',
      { targetId: 'ssh-1' },
      { pairedDeviceId: 'p' }
    )

    expect(response).toMatchObject({ ok: false })
    expect(JSON.stringify(response)).not.toContain('bastion.internal')
  })

  it('answers runtime_unavailable on a host whose SSH layer never registered', async () => {
    const response = await dispatch('ssh.listTargetConfigs')
    expect(response).toMatchObject({ ok: false, error: { code: 'runtime_unavailable' } })
  })
})
