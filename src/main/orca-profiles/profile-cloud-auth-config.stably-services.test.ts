import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as ProductIdentityModule from '../product-identity/product-identity'
import type { ProductIdentity } from '../product-identity/product-identity'
import { podIdentityWithoutStablyServices } from '../product-identity/product-identity.test-fixture'

const identity = vi.hoisted((): { current: ProductIdentity | null } => ({ current: null }))

vi.mock('electron', () => ({ app: { isPackaged: true } }))
vi.mock('../product-identity/product-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof ProductIdentityModule>()),
  getProductIdentity: () => identity.current
}))

import { getOrcaCloudAuthConfig } from './profile-cloud-auth-config'

describe('Orca Cloud sign-in and mobile relay without Stably services', () => {
  afterEach(() => {
    identity.current = null
  })

  it('is configured against login.onorca.dev and relay.onorca.dev for packaged Orca', () => {
    const result = getOrcaCloudAuthConfig({}, true)
    expect(result.configured && result.config.relayDirectorUrl).toBe('https://relay.onorca.dev')
  })

  it('reports unconfigured, which keeps sign-in, orgs, relay and publishing off', () => {
    identity.current = podIdentityWithoutStablyServices()
    // Why env too: a product must not re-enable Stably endpoints through overrides.
    const env = { ORCA_CLOUD_API_URL: 'https://login.onorca.dev', ORCA_CLOUD_CLIENT_ID: 'x' }
    expect(getOrcaCloudAuthConfig(env, true)).toEqual({
      configured: false,
      setupMessage: 'Orca Cloud is not available in Pod.'
    })
  })
})
