import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ProductIdentityModule from '../product-identity/product-identity'
import type { ProductIdentity } from '../product-identity/product-identity'
import { podIdentityWithoutStablyServices } from '../product-identity/product-identity.test-fixture'

const identity = vi.hoisted((): { current: ProductIdentity | null } => ({ current: null }))

vi.mock('electron', () => ({ app: { getLocale: vi.fn(() => 'en-US') } }))
vi.mock('../product-identity/product-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof ProductIdentityModule>()),
  getProductIdentity: () => identity.current
}))

import { UI_LANGUAGE_ENGLISH, UI_LANGUAGE_JAPANESE } from '../../shared/ui-language'
import { ensureMainI18n, setMainUiLanguage, translateMain } from './main-i18n'

describe('main-process menu, tray and dialog copy in a product', () => {
  beforeEach(async () => {
    await ensureMainI18n()
    await setMainUiLanguage(UI_LANGUAGE_ENGLISH)
  })

  afterEach(() => {
    identity.current = null
  })

  it('keeps upstream copy without an identity', () => {
    expect(translateMain('menu.exploreOrca', 'Explore Orca')).toBe('Explore Orca')
  })

  it('renames English fallbacks and lazily loaded catalogs', async () => {
    identity.current = podIdentityWithoutStablyServices()
    expect(translateMain('menu.exploreOrca', 'Explore Orca')).toBe('Explore Pod')
    expect(translateMain('tray.openOrca', 'Open Orca')).toBe('Open Pod')
    expect(translateMain('menu.showMobileButton', 'Show Orca Mobile Button')).toBe(
      'Show Orca Mobile Button'
    )

    await setMainUiLanguage(UI_LANGUAGE_JAPANESE)
    const japanese = translateMain('menu.exploreOrca', 'Explore Orca')
    expect(japanese).toContain('Pod')
    expect(japanese).not.toMatch(/\bOrca\b/)
  })
})
