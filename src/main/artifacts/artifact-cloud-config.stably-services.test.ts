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

import { skillCloudRequest } from '../skills/skill-cloud-request'
import { resolveArtifactCloudApiUrl } from './artifact-cloud-config'

describe('artifact and skill sharing without Stably services', () => {
  afterEach(() => {
    identity.current = null
  })

  it('targets share.onorca.dev for upstream Orca', () => {
    expect(resolveArtifactCloudApiUrl()).toBe('https://share.onorca.dev')
  })

  it('refuses artifact requests before resolving an origin', () => {
    identity.current = podIdentityWithoutStablyServices()
    expect(() => resolveArtifactCloudApiUrl()).toThrow('Sharing is not available in Pod.')
  })

  it('refuses anonymous skill-share lookups without a request', async () => {
    identity.current = podIdentityWithoutStablyServices()
    const fetcher = vi.fn<typeof fetch>()
    await expect(skillCloudRequest({ path: '/v1/skill-shares/abc', fetcher })).rejects.toThrow(
      'Sharing is not available in Pod.'
    )
    expect(fetcher).not.toHaveBeenCalled()
  })
})
