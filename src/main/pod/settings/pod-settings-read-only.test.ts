import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { RuntimeClientSettingsController } from '../../runtime/runtime-client-settings'
import {
  PodSettingsRefusedError,
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

describe('settings a native client reads but never writes', () => {
  it('podSettings and settings.get carry openLinksInApp and sourceControlAi.enabled, read only', async () => {
    vi.useFakeTimers()
    const { store, write, service } = setup({
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
      sourceControlAi: { enabled: true }
    })
    expect(snapshot.values).not.toHaveProperty('openLinksInApp')
    expect(clientSettings.get()).toMatchObject({
      openLinksInApp: true,
      openLinksInAppModifierInverts: false,
      sourceControlAi: { enabled: true, actions: expect.any(Object) }
    })

    // Pod's window changes them: a subscriber hears it under a new revision.
    const changes: PodSettingsChange[] = []
    service.subscribe((change) => changes.push(change))
    store.updateSettings({
      openLinksInAppModifierInverts: true,
      sourceControlAi: { ...store.getSettings().sourceControlAi!, enabled: false }
    })
    vi.advanceTimersByTime(100)
    expect(changes).toEqual([
      expect.objectContaining({
        values: {},
        readOnly: {
          openLinksInApp: true,
          openLinksInAppModifierInverts: true,
          sourceControlAi: { enabled: false }
        }
      })
    ])
    expect(service.get().revision).not.toBe(snapshot.revision)
    expect(clientSettings.get()).toMatchObject({
      openLinksInAppModifierInverts: true,
      sourceControlAi: { enabled: false }
    })

    // A client can't write them.
    const { revision } = service.get()
    for (const values of [{ openLinksInApp: false }, { sourceControlAi: { enabled: true } }]) {
      await expect(service.set(values, revision)).rejects.toThrow(PodSettingsRefusedError)
    }
    expect(write).not.toHaveBeenCalled()
  })
})
