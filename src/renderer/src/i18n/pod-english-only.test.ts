import { afterEach, describe, expect, it, vi } from 'vitest'
import { podFeatureFlags } from '../../../shared/product/features'
import { UI_LANGUAGE_FRENCH, UI_LANGUAGE_SYSTEM } from '../../../shared/ui-language'

describe('Pod English-only profile', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('resolves every UI language to English and hides the language picker', async () => {
    vi.stubGlobal('__POD_FEATURES__', podFeatureFlags('pod'))
    vi.resetModules()
    const { resolveUiLocale } = await import('../../../shared/ui-locale')
    const { SHOW_UI_LANGUAGE_SETTING } = await import('./supported-languages')
    expect(resolveUiLocale(UI_LANGUAGE_FRENCH, 'fr-FR')).toBe('en')
    expect(resolveUiLocale(UI_LANGUAGE_SYSTEM, 'ja-JP')).toBe('en')
    expect(SHOW_UI_LANGUAGE_SETTING).toBe(false)
  })

  it('keeps every upstream language when the profile is not substituted', async () => {
    const { resolveUiLocale } = await import('../../../shared/ui-locale')
    expect(resolveUiLocale(UI_LANGUAGE_FRENCH, 'fr-FR')).toBe('fr')
  })
})
