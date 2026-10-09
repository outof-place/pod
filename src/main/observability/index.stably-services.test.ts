import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as ProductIdentityModule from '../product-identity/product-identity'
import type { ProductIdentity } from '../product-identity/product-identity'
import { podIdentityWithoutStablyServices } from '../product-identity/product-identity.test-fixture'

const identity = vi.hoisted((): { current: ProductIdentity | null } => ({ current: null }))

vi.mock('../product-identity/product-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof ProductIdentityModule>()),
  getProductIdentity: () => identity.current
}))

import { resolveObservabilityConsent } from './index'

describe('diagnostic bundle upload without Stably services', () => {
  const envStash = { ...process.env }

  afterEach(() => {
    identity.current = null
    process.env = { ...envStash }
  })

  it('keeps the local log but disables bundle upload', () => {
    for (const name of ['CI', 'GITHUB_ACTIONS', 'DO_NOT_TRACK', 'ORCA_TELEMETRY_DISABLED']) {
      delete process.env[name]
    }
    expect(resolveObservabilityConsent().bundleEnabled).toBe(true)

    identity.current = podIdentityWithoutStablyServices()
    expect(resolveObservabilityConsent()).toEqual({
      localFileEnabled: true,
      bundleEnabled: false,
      disabledReason: 'orca_telemetry_disabled'
    })
  })
})
