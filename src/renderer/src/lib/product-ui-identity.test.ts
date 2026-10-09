import { afterEach, describe, expect, it } from 'vitest'
import type { ProductUiIdentity } from '../../../shared/product-ui-identity'
import { resolveProductHelpLinks } from './product-help-links'
import { withoutStablyServiceSections } from './product-settings-sections'
import { _resetProductUiIdentityForTests, areStablyServicesAvailable } from './product-ui-identity'

const UPSTREAM_LINKS = {
  docs: 'https://www.onorca.dev/docs',
  changelog: 'https://onorca.dev/changelog',
  github: 'https://github.com/stablyai/orca',
  discord: 'https://discord.gg/fzjDKHxv8Q',
  x: 'https://x.com/orca_build'
}

function stampProduct(product: ProductUiIdentity | null): void {
  Object.assign(globalThis, { window: { api: { product: { get: () => product } } } })
  _resetProductUiIdentityForTests()
}

const SECTIONS = ['general', 'orca-account', 'mobile', 'artifacts', 'share-skills', 'privacy'].map(
  (id) => ({ id })
)

describe('renderer product identity', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window')
    _resetProductUiIdentityForTests()
  })

  it('keeps every upstream entry point when no product is stamped', () => {
    stampProduct(null)
    expect(areStablyServicesAvailable()).toBe(true)
    expect(resolveProductHelpLinks(UPSTREAM_LINKS)).toEqual({ ...UPSTREAM_LINKS, feedback: true })
    expect(withoutStablyServiceSections(SECTIONS)).toEqual(SECTIONS)
  })

  it('hides Stably entry points and links the product repository', () => {
    stampProduct({
      displayName: 'Pod',
      cliName: 'podx',
      stablyServices: false,
      repositoryUrl: 'https://github.com/outof-place/pod'
    })
    expect(areStablyServicesAvailable()).toBe(false)
    expect(resolveProductHelpLinks(UPSTREAM_LINKS)).toEqual({
      docs: null,
      changelog: 'https://github.com/outof-place/pod/releases',
      github: 'https://github.com/outof-place/pod',
      discord: null,
      x: null,
      feedback: false
    })
    expect(withoutStablyServiceSections(SECTIONS).map((section) => section.id)).toEqual([
      'general',
      'privacy'
    ])
  })
})
