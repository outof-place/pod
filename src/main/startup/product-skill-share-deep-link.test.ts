// Fork-only (Pod): a product without Stably's services never opens a skill share link.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as ProductIdentityModule from '../product-identity/product-identity'
import type { ProductIdentity } from '../product-identity/product-identity'
import { podIdentityWithoutStablyServices } from '../product-identity/product-identity.test-fixture'

const identity = vi.hoisted((): { current: ProductIdentity | null } => ({ current: null }))

vi.mock('../product-identity/product-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof ProductIdentityModule>()),
  getProductIdentity: () => identity.current
}))

import { SkillShareDeepLinkState } from './skill-share-deep-link-state'

describe('skill share deep links in a product build', () => {
  afterEach(() => {
    identity.current = null
  })

  it('ignores share links, including its own scheme, when Stably services are off', () => {
    identity.current = podIdentityWithoutStablyServices()
    const state = new SkillShareDeepLinkState()
    const publish = vi.fn()

    expect(state.capture(['pod', 'https://app.orca.dev/skills/share/share_one'], publish)).toBe(
      false
    )
    expect(state.capture(['pod', 'pod://skills/share/share_two'], publish)).toBe(false)
    expect(publish).not.toHaveBeenCalled()
    expect(state.consume()).toBeNull()
  })

  it('keeps upstream behaviour without a product identity', () => {
    const state = new SkillShareDeepLinkState()
    expect(state.capture(['orca', 'orca://skills/share/share_three'])).toBe(true)
    expect(state.consume()).toBe('share_three')
  })
})
