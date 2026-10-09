import { afterEach, describe, expect, it, vi } from 'vitest'
import { readProductUiIdentityArgument } from '../../shared/product-ui-identity'
import type * as ProductIdentityModule from './product-identity'
import type { ProductIdentity } from './product-identity'
import { podIdentityWithoutStablyServices } from './product-identity.test-fixture'

const identity = vi.hoisted((): { current: ProductIdentity | null } => ({ current: null }))

vi.mock('./product-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof ProductIdentityModule>()),
  getProductIdentity: () => identity.current
}))

import {
  areStablyServicesEnabled,
  brandProductCopy,
  productDisplayName,
  productUiIdentityArguments
} from './product-overlay'

describe('product overlay', () => {
  afterEach(() => {
    identity.current = null
  })

  it('is inert for upstream Orca', () => {
    expect(areStablyServicesEnabled()).toBe(true)
    expect(productDisplayName()).toBe('Orca')
    expect(productUiIdentityArguments()).toEqual([])
    expect(brandProductCopy('Orca notifications are on')).toBe('Orca notifications are on')
  })

  it('hands the renderer the product name, CLI, services flag and repository', () => {
    identity.current = podIdentityWithoutStablyServices()
    expect(areStablyServicesEnabled()).toBe(false)
    expect(brandProductCopy('Orca notifications are on')).toBe('Pod notifications are on')
    expect(readProductUiIdentityArgument(productUiIdentityArguments())).toEqual({
      displayName: 'Pod',
      cliName: 'podx',
      stablyServices: false,
      repositoryUrl: 'https://github.com/outof-place/pod'
    })
  })
})
