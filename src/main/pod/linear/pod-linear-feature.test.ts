// Fork-only (Pod): the `linear` feature is on in Pod builds for the runtime alone. The classic
// window's Linear card and settings section stay out, Linear answers only with podLinear on, and
// nothing but the runtime's availability reads the feature.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { POD_FEATURES, podFeatureFlags } from '../../../shared/product/features'
import { podLinearAvailability, setPodLinearEnabledSetting } from './pod-linear-availability'

const SRC = join(__dirname, '../../..')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' ? [] : sourceFiles(path)
    }
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })
}

afterEach(() => {
  setPodLinearEnabledSetting(null)
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('the linear feature in the Pod profile', () => {
  it('is on for the runtime and keeps the SDK, while the classic UI feature is off', () => {
    const pod = podFeatureFlags('pod')
    expect(pod.linear).toBe(true)
    expect(pod.linearClassicUi).toBe(false)
    // The cut stays for a profile that turns Linear off; Pod's doesn't apply it.
    expect(POD_FEATURES.linear.packaging?.dropRuntimePackageRoots).toEqual(['@linear/sdk'])
    expect(POD_FEATURES.linearClassicUi.settingsSections).toEqual(['linear'])
  })

  it('hides the classic card and the Linear settings section in a Pod build', async () => {
    vi.stubGlobal('__POD_FEATURES__', podFeatureFlags('pod'))
    const features = await import('../../../shared/product/features')

    expect(features.POD_LINEAR).toBe(true)
    expect(features.POD_LINEAR_CLASSIC_UI).toBe(false)
    expect(features.isPodSettingsSectionEnabled('linear')).toBe(false)
  })

  it('answers only with podLinear on', () => {
    const sdk = () => true
    expect(podLinearAvailability(podFeatureFlags('pod').linear, sdk)).toEqual({
      available: false,
      reason: 'setting-off'
    })
    setPodLinearEnabledSetting({ read: () => true, write: () => {} })
    expect(podLinearAvailability(podFeatureFlags('pod').linear, sdk)).toEqual({ available: true })
  })

  it('is read only by the runtime availability; the card only behind the classic UI flag', () => {
    const readers = sourceFiles(SRC)
      .filter((path) =>
        /\bPOD_LINEAR\b|__POD_FEATURES__\.linear\b/.test(readFileSync(path, 'utf8'))
      )
      .map((path) => relative(SRC, path))
      .sort()
    expect(readers).toEqual([
      'main/pod/linear/pod-linear-availability.ts',
      'shared/product/features.ts'
    ])
    const pane = readFileSync(
      join(SRC, 'renderer/src/components/settings/IntegrationsPane.tsx'),
      'utf8'
    )
    expect(pane).toContain('{POD_LINEAR_CLASSIC_UI ? <LinearIntegrationCard /> : null}')
  })
})
