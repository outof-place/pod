import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { RuntimeClientSettingsController } from '../../runtime/runtime-client-settings'
import {
  PodSettingsService,
  setPodSettingsService,
  type PodSettingsChange
} from './pod-settings-service'

function setup(overrides: Partial<GlobalSettings>) {
  let settings: GlobalSettings = { ...getDefaultSettings('/Users/e2e'), ...overrides }
  const listeners = new Set<(updates: Partial<GlobalSettings>) => void>()
  const store = {
    getSettings: () => settings,
    onSettingsChanged: (listener: (updates: Partial<GlobalSettings>) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    updateSettings: (updates: Partial<GlobalSettings>) => {
      settings = { ...settings, ...updates }
      for (const listener of listeners) {
        listener(updates)
      }
    }
  }
  const write = vi.fn(async (values: Partial<GlobalSettings>) => {
    store.updateSettings(values)
    return settings
  })
  return { store, write, service: new PodSettingsService(store, write) }
}

afterEach(() => {
  setPodSettingsService(null)
  vi.useRealTimers()
})

// PodNative before R1 reads these from `readOnly` and never writes them; since R1 they are fields.
describe('the read-only mirror older native clients follow', () => {
  it('podSettings and settings.get still carry openLinksInApp and sourceControlAi.enabled', () => {
    vi.useFakeTimers()
    const { store, service } = setup({
      openLinksInApp: true,
      sourceControlAi: { ...getDefaultSettings('/Users/e2e').sourceControlAi!, enabled: true }
    })
    const clientSettings = new RuntimeClientSettingsController(store)

    // Upstream Orca, without Pod's settings service: settings.get stays as it is.
    expect(clientSettings.get()).not.toHaveProperty('openLinksInApp')
    expect(clientSettings.get().sourceControlAi).not.toHaveProperty('enabled')

    setPodSettingsService(service)
    const snapshot = service.get()
    expect(snapshot.readOnly).toEqual({
      openLinksInApp: true,
      openLinksInAppModifierInverts: false,
      sourceControlAi: { enabled: true },
      promptCacheTimerEnabled: false,
      promptCacheTtlMs: 300_000,
      terminalCustomThemes: []
    })
    expect(clientSettings.get()).toMatchObject({
      openLinksInApp: true,
      openLinksInAppModifierInverts: false,
      sourceControlAi: { enabled: true, actions: expect.any(Object) }
    })

    // A change elsewhere reaches a subscriber as the field and, for older clients, the mirror.
    const changes: PodSettingsChange[] = []
    service.subscribe((change) => changes.push(change))
    store.updateSettings({
      openLinksInAppModifierInverts: true,
      sourceControlAi: { ...store.getSettings().sourceControlAi!, enabled: false }
    })
    vi.advanceTimersByTime(100)
    expect(changes).toEqual([
      expect.objectContaining({
        values: {
          openLinksInAppModifierInverts: true,
          sourceControlAi: expect.objectContaining({ enabled: false })
        },
        readOnly: expect.objectContaining({
          openLinksInAppModifierInverts: true,
          sourceControlAi: { enabled: false }
        })
      })
    ])
    expect(clientSettings.get()).toMatchObject({
      openLinksInAppModifierInverts: true,
      sourceControlAi: { enabled: false }
    })
  })

  it('a native pane writes them now, and the mirror follows', async () => {
    const { store, write, service } = setup({ promptCacheTtlMs: 300_000 })
    const result = await service.set(
      { openLinksInApp: true, promptCacheTimerEnabled: true, promptCacheTtlMs: 3_600_000 },
      service.get().revision
    )
    expect(write).toHaveBeenCalledWith({
      openLinksInApp: true,
      promptCacheTimerEnabled: true,
      promptCacheTtlMs: 3_600_000
    })
    expect(result).toMatchObject({
      ok: true,
      values: { openLinksInApp: true, promptCacheTimerEnabled: true, promptCacheTtlMs: 3_600_000 },
      readOnly: { openLinksInApp: true, promptCacheTimerEnabled: true, promptCacheTtlMs: 3_600_000 }
    })
    expect(store.getSettings().openLinksInApp).toBe(true)
  })

  it("mirrors the desktop's reading of a lifetime it wouldn't use", () => {
    const { store, service } = setup({})
    store.updateSettings({ promptCacheTimerEnabled: true, promptCacheTtlMs: -1 })
    const snapshot = service.get()
    expect(snapshot.readOnly).toMatchObject({ promptCacheTtlMs: 300_000 })
    expect(snapshot.values).not.toHaveProperty('promptCacheTtlMs')
  })
})
