import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeTestStores, createStore, testState } from '../../persistence-test-harness'
import type { Store } from '../../persistence'
import { RpcDispatcher } from '../../runtime/rpc/dispatcher'
import type { RpcResponse } from '../../runtime/rpc/core'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { POD_SSH_TARGET_METHODS } from '../../runtime/rpc/methods/pod-ssh-targets'
import { SshConnectionStore } from '../../ssh/ssh-connection-store'
import { setSshTargetRegistryStore } from '../../ssh/ssh-target-registry'
import { installPodSshTargetSettings } from './install-pod-ssh-target-settings'
import { setPodSshTargetSettingsOps } from './pod-ssh-target-settings'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the methods read only the runtime id and the repo-change notifier.
const runtime = {
  getRuntimeId: () => 'test-runtime',
  notifyReposChangedForRemoteClients: vi.fn()
} as unknown as OrcaRuntimeService

let store: Store

async function call(method: string, params?: unknown): Promise<RpcResponse> {
  return new RpcDispatcher({ runtime, methods: POD_SSH_TARGET_METHODS }).dispatch({
    id: 'req-1',
    authToken: 'tok',
    method,
    params
  })
}

async function result(method: string, params?: unknown): Promise<Record<string, unknown>> {
  const response = await call(method, params)
  if (!response.ok) {
    throw new Error(`${method}: ${response.error.message}`)
  }
  const value = response.result
  return typeof value === 'object' && value !== null
    ? Object.fromEntries(Object.entries(value))
    : {}
}

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'pod-ssh-settings-'))
  store = createStore()
  setSshTargetRegistryStore(new SshConnectionStore(store))
  installPodSshTargetSettings()
})

afterEach(async () => {
  setPodSshTargetSettingsOps(null)
  setSshTargetRegistryStore(null)
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

describe('PodNative SSH settings on the real target store', () => {
  it('adds a host the store keeps, with a fresh registration', async () => {
    const added = await result('ssh.addTarget', {
      target: { host: 'dev.example.com', port: 2222, username: 'me', identityFile: '~/.ssh/dev' }
    })

    const [saved] = store.getSshTargets()
    expect(saved).toMatchObject({
      label: 'me@dev.example.com',
      host: 'dev.example.com',
      configHost: 'dev.example.com',
      port: 2222,
      username: 'me',
      identityFile: '~/.ssh/dev',
      source: 'manual'
    })
    expect(typeof saved?.generation).toBe('number')
    expect(added.target).toMatchObject({ id: saved?.id, managedServer: false })
    await expect(result('ssh.listTargetConfigs')).resolves.toMatchObject({
      targets: [{ id: saved?.id, port: 2222 }]
    })
  })

  it('saves an edit over the stored host and drops what the form cleared', async () => {
    const added = await result('ssh.addTarget', {
      target: { host: 'dev.example.com', port: 22, identityFile: '~/.ssh/dev', jumpHost: 'gw' }
    })
    const id = String(Reflect.get(Object(added.target), 'id'))

    await result('ssh.updateTarget', {
      targetId: id,
      target: { host: 'dev.example.com', port: 22, label: 'Dev box', jumpHost: 'gw' }
    })

    const saved = store.getSshTarget(id)
    expect(saved).toMatchObject({ label: 'Dev box', jumpHost: 'gw', source: 'manual' })
    expect(saved?.identityFile).toBeUndefined()
  })

  it('removes the host and remembers it for re-adoption', async () => {
    const added = await result('ssh.addTarget', { target: { host: 'old.example.com', port: 22 } })
    const id = String(Reflect.get(Object(added.target), 'id'))

    await expect(result('ssh.removeTarget', { targetId: id })).resolves.toEqual({ removed: true })

    expect(store.getSshTarget(id)).toBeUndefined()
    expect(store.getRemovedSshTargetTombstones().map((tombstone) => tombstone.oldTargetId)).toEqual(
      [id]
    )
  })

  it('refuses to remove a managed server host and keeps it', async () => {
    const added = await result('ssh.addTarget', { target: { host: 'srv.example.com', port: 22 } })
    const id = String(Reflect.get(Object(added.target), 'id'))
    store.updateSshTarget(id, { orcadFence: { environmentId: 'env-1' } })

    const response = await call('ssh.removeTarget', { targetId: id })

    expect(response).toMatchObject({ ok: false })
    expect(JSON.stringify(response)).toContain('managed Orca server')
    expect(store.getSshTarget(id)).toBeDefined()
  })
})
