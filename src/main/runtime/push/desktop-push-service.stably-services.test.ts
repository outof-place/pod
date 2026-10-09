import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as ProductIdentityModule from '../../product-identity/product-identity'
import type { ProductIdentity } from '../../product-identity/product-identity'
import { podIdentityWithoutStablyServices } from '../../product-identity/product-identity.test-fixture'
import { DeviceRegistry } from '../device-registry'
import { DesktopPushService } from './desktop-push-service'
import { createPushHostKeypair } from './push-host-challenge-fixtures'
import { PushUnregisterOutbox } from './push-unregister-outbox'

const identity = vi.hoisted((): { current: ProductIdentity | null } => ({ current: null }))

vi.mock('../../product-identity/product-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof ProductIdentityModule>()),
  getProductIdentity: () => identity.current
}))

function createOptions(): Parameters<typeof DesktopPushService.create>[0] {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-push-stably-'))
  const registry = new DeviceRegistry(userDataPath)
  registry.addDevice('phone', 'mobile')
  const runtimeRpc = {
    getE2EEKeypair: () => createPushHostKeypair(),
    getDeviceRegistry: () => registry,
    getPushUnregisterOutbox: () => new PushUnregisterOutbox(userDataPath),
    setOnPushUnregisterQueued: vi.fn()
  }
  const runtime = { setMobilePushRegistrar: vi.fn(), onNotificationDispatched: vi.fn() }
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: create() reads only the members stubbed above.
    runtime: runtime as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: create() and start() read only the members stubbed above.
    runtimeRpc: runtimeRpc as never,
    gatewayUrl: 'https://push.onorca.dev'
  }
}

describe('mobile push without Stably services', () => {
  afterEach(() => {
    identity.current = null
    vi.unstubAllGlobals()
  })

  it('starts for upstream Orca when a phone is paired', () => {
    expect(DesktopPushService.create(createOptions())).not.toBeNull()
  })

  it('never creates the push.onorca.dev client', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    identity.current = podIdentityWithoutStablyServices()

    expect(DesktopPushService.create(createOptions())).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
