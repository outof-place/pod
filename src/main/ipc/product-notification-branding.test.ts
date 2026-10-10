import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as ProductIdentityModule from '../product-identity/product-identity'
import type { ProductIdentity } from '../product-identity/product-identity'
import { podIdentityWithoutStablyServices } from '../product-identity/product-identity.test-fixture'

const identity = vi.hoisted((): { current: ProductIdentity | null } => ({ current: null }))
const created = vi.hoisted((): { title: string; body: string }[] => [])

vi.mock('../product-identity/product-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof ProductIdentityModule>()),
  getProductIdentity: () => identity.current
}))

vi.mock('electron', () => {
  class RecordingNotification {
    static isSupported(): boolean {
      return true
    }
    title: string
    body: string
    constructor(options: { title: string; body: string }) {
      this.title = options.title
      this.body = options.body
      created.push(this)
    }
    on(): this {
      return this
    }
    removeListener(): this {
      return this
    }
    show(): void {}
    close(): void {}
  }
  return { Notification: RecordingNotification }
})

import { brandNotificationCopy } from '../product-identity/product-overlay'
import { probeNotificationDelivery } from './notification-permission-probe'

describe('native notification copy in a product build', () => {
  afterEach(() => {
    identity.current = null
    created.length = 0
  })

  it('leaves upstream copy alone without an identity', () => {
    const notification = { title: 'Orca notifications are on', body: 'From Orca.' }
    brandNotificationCopy(notification)
    expect(notification).toEqual({ title: 'Orca notifications are on', body: 'From Orca.' })
  })

  it('names the product on a notification upstream builds', () => {
    identity.current = podIdentityWithoutStablyServices()
    void probeNotificationDelivery()
    expect(created).toEqual([
      expect.objectContaining({
        title: 'Pod notifications are on',
        body: 'Pod will alert you when agents finish or terminals need attention.'
      })
    ])
  })
})
