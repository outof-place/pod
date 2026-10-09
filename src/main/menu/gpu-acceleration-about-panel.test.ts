import { describe, expect, it } from 'vitest'
import {
  createGpuAccelerationAboutPanelOptions,
  describeGpuAcceleration
} from './gpu-acceleration-about-panel'

describe('GPU acceleration About panel', () => {
  it.each([
    ['enabled', 'Enabled'],
    ['disabled_off', 'Disabled'],
    ['disabled_software', 'Software rendering'],
    ['unavailable_software', 'Software rendering'],
    ['unavailable', 'Unavailable'],
    ['undefined', 'Status unavailable']
  ])('describes Chromium compositing status %s', (gpu_compositing, expected) => {
    expect(describeGpuAcceleration({ gpu_compositing }, false)).toBe(expected)
  })

  it('gives Safe Graphics Mode precedence over Chromium status', () => {
    expect(describeGpuAcceleration({ gpu_compositing: 'enabled' }, true)).toBe(
      'Disabled (Safe Graphics Mode)'
    )
  })

  it('reports status as unavailable until Chromium publishes GPU information', () => {
    expect(describeGpuAcceleration(null, false)).toBe('Status unavailable')
  })

  it('uses the Linux-visible copyright field', () => {
    expect(
      createGpuAccelerationAboutPanelOptions({
        appName: 'Orca',
        appVersion: '1.2.3',
        platform: 'linux',
        gpuFallbackActive: false,
        gpuFeatureStatus: { gpu_compositing: 'enabled' }
      })
    ).toEqual({
      applicationName: 'Orca',
      applicationVersion: '1.2.3',
      copyright: 'GPU acceleration: Enabled'
    })
  })

  it.each(['darwin', 'win32'] satisfies NodeJS.Platform[])('uses credits on %s', (platform) => {
    expect(
      createGpuAccelerationAboutPanelOptions({
        appName: 'Orca',
        appVersion: '1.2.3',
        platform,
        gpuFallbackActive: true,
        gpuFeatureStatus: null
      })
    ).toEqual({
      applicationName: 'Orca',
      applicationVersion: '1.2.3',
      credits: 'GPU acceleration: Disabled (Safe Graphics Mode)'
    })
  })

  it('credits Orca and shows the product copyright for a downstream product', () => {
    expect(
      createGpuAccelerationAboutPanelOptions({
        appName: 'Pod',
        appVersion: '1.2.3',
        platform: 'darwin',
        gpuFallbackActive: false,
        gpuFeatureStatus: { gpu_compositing: 'enabled' },
        product: {
          copyright: 'Copyright © 2026 outofplace',
          credits: 'Built on Orca by Stably (MIT)'
        }
      })
    ).toEqual({
      applicationName: 'Pod',
      applicationVersion: '1.2.3',
      copyright: 'Copyright © 2026 outofplace',
      credits: 'Built on Orca by Stably (MIT)\n\nGPU acceleration: Enabled'
    })
  })

  it('names the Orca release a downstream product is based on', () => {
    const options = createGpuAccelerationAboutPanelOptions({
      appName: 'Pod',
      appVersion: '0.1.0',
      platform: 'darwin',
      gpuFallbackActive: false,
      gpuFeatureStatus: { gpu_compositing: 'enabled' },
      product: { copyright: 'Copyright © 2026 outofplace', credits: 'Built on Orca.' },
      upstream: { tag: 'v1.4.223', sha: '5272afeda68c2fe2bbdc3f09159c66688dc27328' }
    })
    expect(options.credits).toBe(
      'Built on Orca.\nBased on Orca v1.4.223 (5272afeda6)\n\nGPU acceleration: Enabled'
    )
    expect(
      createGpuAccelerationAboutPanelOptions({
        appName: 'Pod',
        appVersion: '0.1.0',
        platform: 'darwin',
        gpuFallbackActive: false,
        gpuFeatureStatus: null,
        product: { copyright: 'c', credits: 'Built on Orca.' },
        upstream: { tag: null, sha: 'abcdef0123456789' }
      }).credits
    ).toBe('Built on Orca.\nBased on Orca (abcdef0123)\n\nGPU acceleration: Status unavailable')
  })
})
