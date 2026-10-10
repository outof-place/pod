import { afterEach, describe, expect, it, vi } from 'vitest'
import { podFeatureFlags } from '../../shared/product/features'

async function loadSupport(profile: 'pod' | 'orca') {
  vi.resetModules()
  if (profile === 'pod') {
    vi.stubGlobal('__POD_FEATURES__', podFeatureFlags('pod'))
  }
  return import('./pod-ssh-host-support')
}

describe('Pod SSH host support', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('rejects Windows hosts in the Pod profile with a clear message', async () => {
    const { assertPodSupportsSshHostPlatform } = await loadSupport('pod')
    for (const platform of ['win32-x64', 'win32-arm64'] as const) {
      expect(() => assertPodSupportsSshHostPlatform(platform)).toThrow(
        `Pod does not support Windows SSH hosts (this host is ${platform}). Connect to a Linux or macOS host instead.`
      )
    }
    for (const platform of ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'] as const) {
      expect(() => assertPodSupportsSshHostPlatform(platform)).not.toThrow()
    }
  })

  it('accepts Windows hosts when the profile is not substituted', async () => {
    const { assertPodSupportsSshHostPlatform } = await loadSupport('orca')
    expect(() => assertPodSupportsSshHostPlatform('win32-x64')).not.toThrow()
    expect(() => assertPodSupportsSshHostPlatform('win32-arm64')).not.toThrow()
  })
})
