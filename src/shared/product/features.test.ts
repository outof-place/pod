import { describe, expect, it } from 'vitest'
import {
  POD_FEATURE_IDS,
  POD_FEATURE_PROMOS,
  isPodSettingsSectionEnabled,
  podFeatureDefines,
  podFeatureFlags,
  podStubModules
} from './features'

describe('Pod build profile', () => {
  it('keeps every feature on when no build substitutes the profile', () => {
    expect(POD_FEATURE_PROMOS).toBe(true)
    expect(isPodSettingsSectionEnabled('setup-guide')).toBe(true)
  })

  it('turns the cut list off only in the pod profile', () => {
    expect(Object.values(podFeatureFlags('orca')).every(Boolean)).toBe(true)
    expect(podFeatureFlags('pod').featurePromos).toBe(false)
  })

  it('defines the whole object and one literal per flag', () => {
    const defines = podFeatureDefines('pod')
    expect(JSON.parse(defines.__POD_FEATURES__)).toEqual(podFeatureFlags('pod'))
    for (const id of POD_FEATURE_IDS) {
      expect(defines[`__POD_FEATURES__.${id}`]).toBe(String(podFeatureFlags('pod')[id]))
    }
  })

  it('stubs only the non-English catalogs', () => {
    const stubs = podStubModules('pod')
    const stubbed = (path: string): boolean => stubs.some((pattern) => pattern.test(path))
    expect(stubbed('/repo/src/renderer/src/i18n/locales/fr.json')).toBe(true)
    expect(stubbed('/repo/src/renderer/src/i18n/locales/en.json')).toBe(false)
    expect(podStubModules('orca')).toEqual([])
  })
})
