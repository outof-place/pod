import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as ProductIdentityModule from '../product-identity/product-identity'
import type { ProductIdentity } from '../product-identity/product-identity'
import { podIdentityWithoutStablyServices } from '../product-identity/product-identity.test-fixture'

const identity = vi.hoisted((): { current: ProductIdentity | null } => ({ current: null }))

vi.mock('../product-identity/product-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof ProductIdentityModule>()),
  getProductIdentity: () => identity.current
}))

import { buildNotificationOptions } from './notification-options'

describe('notification titles in a product build', () => {
  afterEach(() => {
    identity.current = null
  })

  it('keeps the upstream test notification without an identity', () => {
    expect(buildNotificationOptions({ source: 'test' })).toEqual({
      title: 'Orca notifications are on',
      body: 'This is a test notification from Orca.'
    })
  })

  it('names the product in the test notification', () => {
    identity.current = podIdentityWithoutStablyServices()
    expect(buildNotificationOptions({ source: 'test' })).toEqual({
      title: 'Pod notifications are on',
      body: 'This is a test notification from Pod.'
    })
  })
})
