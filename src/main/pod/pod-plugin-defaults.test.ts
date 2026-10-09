import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setDistroPluginPolicy } from '../../shared/distro/distro-plugin-policy'
import {
  approveDistroBundledPlugins,
  enablePluginSystemOnce,
  POD_PLUGIN_DEFAULTS_MARKER
} from './pod-plugin-defaults'

function store(settings: Record<string, unknown>) {
  return {
    settings,
    getSettings: () => settings,
    updateSettings: vi.fn((updates: Record<string, unknown>) => Object.assign(settings, updates))
  }
}

const dirs: string[] = []
afterEach(() => {
  setDistroPluginPolicy(null)
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('Pod plugin defaults', () => {
  it('does nothing in upstream builds', () => {
    const s = store({ pluginSystemEnabled: false })
    const dir = mkdtempSync(join(tmpdir(), 'pod-defaults-'))
    dirs.push(dir)
    expect(enablePluginSystemOnce(s, dir)).toBe(false)
    expect(s.updateSettings).not.toHaveBeenCalled()
    expect(existsSync(join(dir, POD_PLUGIN_DEFAULTS_MARKER))).toBe(false)
  })

  it('turns the plugin system on once, then respects the user turning it off', () => {
    setDistroPluginPolicy({
      publishers: ['outof-place'],
      idPrefix: 'pod-',
      enablePluginSystem: true
    })
    const s = store({ pluginSystemEnabled: false })
    const dir = mkdtempSync(join(tmpdir(), 'pod-defaults-'))
    dirs.push(dir)
    expect(enablePluginSystemOnce(s, dir)).toBe(true)
    expect(s.settings.pluginSystemEnabled).toBe(true)
    s.settings.pluginSystemEnabled = false
    expect(enablePluginSystemOnce(s, dir)).toBe(false)
    expect(s.settings.pluginSystemEnabled).toBe(false)
  })

  it('approves only the distro bundled plugins the user has not disabled or already approved', async () => {
    setDistroPluginPolicy({
      publishers: ['outof-place'],
      idPrefix: 'pod-',
      enablePluginSystem: true
    })
    const s = store({
      disabledPlugins: ['outof-place.pod-off'],
      pluginConsents: { 'outof-place.pod-same': 'fp-same' }
    })
    const approve = vi.fn().mockResolvedValue(undefined)
    const approved = await approveDistroBundledPlugins({
      pluginKeys: [
        'outof-place.pod-acc',
        'outof-place.pod-off',
        'outof-place.pod-same',
        'stablyai.orca-theme',
        'outof-place.pod-gone'
      ],
      store: s,
      findPlugin: (pluginKey) =>
        pluginKey === 'outof-place.pod-gone'
          ? null
          : {
              pluginKey,
              consentFingerprint: pluginKey === 'outof-place.pod-same' ? 'fp-same' : 'fp-new'
            },
      approve
    })
    expect(approved).toEqual(['outof-place.pod-acc'])
    expect(approve).toHaveBeenCalledWith({
      pluginKey: 'outof-place.pod-acc',
      consentFingerprint: 'fp-new'
    })
  })
})
