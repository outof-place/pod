import { afterEach, describe, expect, it, vi } from 'vitest'
import { podFeatureFlags } from '../../../shared/product/features'

async function loadAppFontFamily(profile: 'pod' | 'orca') {
  vi.resetModules()
  if (profile === 'pod') {
    vi.stubGlobal('__POD_FEATURES__', podFeatureFlags('pod'))
  }
  const [{ buildAppFontFamily }, { DEFAULT_APP_FONT_FAMILY }] = await Promise.all([
    import('./app-font-family'),
    import('../../../shared/constants')
  ])
  return { buildAppFontFamily, DEFAULT_APP_FONT_FAMILY }
}

describe('Pod app font family', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('defaults to the macOS system font without Geist in the Pod profile', async () => {
    const { buildAppFontFamily, DEFAULT_APP_FONT_FAMILY } = await loadAppFontFamily('pod')
    expect(DEFAULT_APP_FONT_FAMILY).toBe('system-ui')
    expect(buildAppFontFamily(undefined)).toMatch(/^system-ui, /)
    expect(buildAppFontFamily(undefined)).not.toMatch(/Geist/)
    expect(buildAppFontFamily('Geist')).toMatch(/^"Geist", system-ui, /)
  })

  it('keeps Geist when the profile is not substituted', async () => {
    const { buildAppFontFamily, DEFAULT_APP_FONT_FAMILY } = await loadAppFontFamily('orca')
    expect(DEFAULT_APP_FONT_FAMILY).toBe('Geist')
    expect(buildAppFontFamily(undefined)).toMatch(/^"Geist", /)
  })
})
