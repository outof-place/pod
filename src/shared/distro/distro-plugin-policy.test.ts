import { afterEach, describe, expect, it } from 'vitest'
import { isBundledPluginIdentity, isOfficialPluginIdentity } from '../plugins/plugin-marketplace'
import { isDistroPluginIdentity, setDistroPluginPolicy } from './distro-plugin-policy'

afterEach(() => setDistroPluginPolicy(null))

describe('distro plugin policy', () => {
  it('is empty upstream: only official identities may be bundled', () => {
    expect(isDistroPluginIdentity('outof-place.pod-acc')).toBe(false)
    expect(isBundledPluginIdentity('outof-place.pod-acc')).toBe(false)
    expect(isBundledPluginIdentity('stablyai.orca-theme')).toBe(true)
  })

  it('admits the product publisher with its id prefix and nothing else', () => {
    setDistroPluginPolicy({
      publishers: ['outof-place'],
      idPrefix: 'pod-',
      enablePluginSystem: true
    })
    expect(isBundledPluginIdentity('outof-place.pod-acc')).toBe(true)
    expect(isOfficialPluginIdentity('outof-place.pod-acc')).toBe(false)
    for (const key of [
      'outof-place.claude-acc',
      'outof-place.pod-',
      'someone.pod-acc',
      'outof-placepod-acc',
      'pod-acc'
    ]) {
      expect(isDistroPluginIdentity(key), key).toBe(false)
    }
  })
})
