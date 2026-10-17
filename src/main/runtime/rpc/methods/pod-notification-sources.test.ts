import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { POD_NOTIFICATION_SOURCE_METHODS } from './pod-notification-sources'
import { RUNTIME_CAPABILITIES } from '../../../../shared/protocol-version'
import { POD_NOTIFICATION_SOURCES_RUNTIME_CAPABILITY } from '../../../../shared/pod-runtime-capabilities'

const registry = vi.hoisted(() => ({
  targets: [{ id: 'box', label: 'Build box', host: 'box.internal', port: 22, username: 'dev' }],
  environments: [
    {
      id: 'hub',
      name: 'Hub',
      endpoints: [
        { id: 'e1', kind: 'websocket', endpoint: 'wss://hub', deviceToken: 'secret-token' }
      ]
    }
  ]
}))

vi.mock('../../../ssh/ssh-target-registry', () => ({
  listRegisteredSshTargets: () => registry.targets,
  getRegisteredSshState: () => undefined
}))
vi.mock('../../../../shared/runtime-environment-store', () => ({
  listEnvironments: () => registry.environments
}))
vi.mock('../../../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: () => '/tmp/pod-notification-sources-test' })
}))

function dispatcher() {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only getClientSettings().
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    getClientSettings: () => ({
      hostSettingOverrides: { 'runtime:hub': { displayLabel: 'Team hub' } }
    })
  } as unknown as OrcaRuntimeService
  return new RpcDispatcher({ runtime, methods: POD_NOTIFICATION_SOURCE_METHODS })
}

const request = { id: 'req-1', authToken: 'tok', method: 'notifications.sources' }

describe('notifications.sources (Pod)', () => {
  it("lists this computer's machines for its own clients", async () => {
    const response = await dispatcher().dispatch(request)
    expect(response).toMatchObject({
      ok: true,
      result: {
        sources: expect.arrayContaining([
          expect.objectContaining({ id: 'local', aliasIds: [] }),
          { id: 'ssh:box', label: 'Build box', aliasIds: [] },
          { id: 'runtime:hub', label: 'Team hub', aliasIds: [] }
        ])
      }
    })
    // A server's device token never leaves the host.
    expect(JSON.stringify(response)).not.toContain('secret-token')
  })

  it('refuses a paired device', async () => {
    const response = await dispatcher().dispatch(request, { pairedDeviceId: 'phone-1' })
    expect(response).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  })

  it('is host-admin, and Pod hosts say they serve it', () => {
    expect(POD_NOTIFICATION_SOURCE_METHODS[0]?.permission).toBe('host-admin')
    expect(RUNTIME_CAPABILITIES).toContain(POD_NOTIFICATION_SOURCES_RUNTIME_CAPABILITY)
  })
})
