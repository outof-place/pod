import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import {
  POD_SETTINGS_HIDDEN,
  POD_SETTINGS_SECRET_KEYS
} from '../../../shared/pod-settings-classification'
import { PROTECTED_SECRET_SLOT } from '../../protected-secret-persistence'
import {
  POD_SETTINGS_COALESCE_MS,
  PodSettingsRefusedError,
  PodSettingsService,
  type PodSettingsChange
} from './pod-settings-service'

const SECRETS = {
  httpProxyUrl: 'http://user:hunter2@proxy.example.invalid:3128',
  opencodeSessionCookie: 'session=secret-cookie',
  agentDefaultEnv: { claude: { ANTHROPIC_API_KEY: 'sk-ant-secret' } },
  telemetry: { optedIn: false, installId: 'install-secret', existedBeforeTelemetryRelease: true }
} satisfies Partial<GlobalSettings>

function fakeStore() {
  let settings: GlobalSettings = { ...getDefaultSettings('/Users/e2e'), ...SECRETS }
  const listeners = new Set<(updates: Partial<GlobalSettings>) => void>()
  return {
    getSettings: () => settings,
    onSettingsChanged: (listener: (updates: Partial<GlobalSettings>) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    /** Stands in for the store write and its listeners (notifyListeners: true). */
    update(updates: Partial<GlobalSettings>, notify = true) {
      settings = { ...settings, ...updates }
      if (notify) {
        for (const listener of listeners) {
          listener(updates)
        }
      }
      return settings
    },
    listenerCount: () => listeners.size
  }
}

function setup() {
  const store = fakeStore()
  const write = vi.fn(async (values: Partial<GlobalSettings>) => store.update(values))
  return { store, write, service: new PodSettingsService(store, write) }
}

const secretTexts = [
  ...Object.values(SECRETS).flatMap((value) => JSON.stringify(value)),
  'hunter2',
  'sk-ant-secret',
  'install-secret',
  'secret-cookie'
]

describe('PodSettingsService secrets', () => {
  it('keeps every protected store secret on the deny list', () => {
    const settingsSlots = Object.values(PROTECTED_SECRET_SLOT)
      .filter((slot) => slot.startsWith('settings.'))
      .map((slot) => slot.slice('settings.'.length))
    expect(settingsSlots.length).toBeGreaterThan(0)
    for (const key of settingsSlots) {
      expect(POD_SETTINGS_SECRET_KEYS).toContain(key)
    }
  })

  it('never names or shows a secret or hidden key in schema or get', () => {
    const { service } = setup()
    const schema = JSON.stringify(service.schema())
    const values = service.get().values
    for (const key of [...POD_SETTINGS_SECRET_KEYS, ...Object.keys(POD_SETTINGS_HIDDEN)]) {
      expect(schema).not.toContain(`"${key}"`)
      expect(values).not.toHaveProperty(key)
    }
    for (const text of secretTexts) {
      expect(schema).not.toContain(text)
      expect(JSON.stringify(values)).not.toContain(text)
    }
  })

  it('refuses a secret or hidden key without writing', async () => {
    const { service, write } = setup()
    const { revision } = service.get()
    for (const key of POD_SETTINGS_SECRET_KEYS) {
      await expect(service.set({ [key]: 'x' }, revision)).rejects.toThrow(PodSettingsRefusedError)
    }
    await expect(service.set({ pluginConsents: {} }, revision)).rejects.toThrow(
      PodSettingsRefusedError
    )
    await expect(service.set({ terminalFontSize: 'big' }, revision)).rejects.toThrow(
      PodSettingsRefusedError
    )
    expect(write).not.toHaveBeenCalled()
  })
})

describe('PodSettingsService.set', () => {
  it('writes through the shared path and hands back the new revision', async () => {
    const { service, write } = setup()
    const before = service.get()
    const result = await service.set({ terminalFontSize: 16 }, before.revision)
    expect(write).toHaveBeenCalledWith({ terminalFontSize: 16 })
    expect(result).toMatchObject({ ok: true, values: { terminalFontSize: 16 } })
    expect(result.revision).not.toBe(before.revision)
  })

  it('returns the current values on a stale revision and writes nothing', async () => {
    const { service, store, write } = setup()
    const stale = service.get().revision
    store.update({ terminalFontSize: 18 })
    const result = await service.set({ terminalFontSize: 16 }, stale)
    expect(result).toMatchObject({
      ok: false,
      reason: 'conflict',
      values: { terminalFontSize: 18 }
    })
    expect(result.revision).toBe(service.get().revision)
    expect(write).not.toHaveBeenCalled()
  })

  it('sees a write that skipped the change listeners as a conflict too', async () => {
    const { service, store, write } = setup()
    const stale = service.get().revision
    store.update({ theme: 'dark' }, false)
    expect((await service.set({ theme: 'light' }, stale)).ok).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })

  it('keeps one revision while only hidden or secret keys change', () => {
    const { service, store } = setup()
    const { revision } = service.get()
    store.update({ httpProxyUrl: '', localBaseRefSuggestionDismissed: true })
    expect(service.get().revision).toBe(revision)
  })

  it('writes a partial notifications change as the whole object', async () => {
    const { service, store, write } = setup()
    await service.set({ notifications: { terminalBell: false } }, service.get().revision)
    expect(write).toHaveBeenCalledWith({
      notifications: { ...getDefaultSettings('/Users/e2e').notifications, terminalBell: false }
    })
    expect(store.getSettings().notifications.mutedNotificationSourceIds).toEqual([])
    expect(service.get().values.notifications).not.toHaveProperty('mutedNotificationSourceIds')
  })

  it('reads the legacy awake boolean as a mode', () => {
    const { service, store } = setup()
    store.update({ computerAwakeMode: undefined, keepComputerAwakeWhileAgentsRun: true })
    expect(service.get().values.computerAwakeMode).toBe('auto')
  })
})

describe('PodSettingsService.subscribe', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('folds a burst into one change of the fields that moved', () => {
    const { service, store } = setup()
    const changes: PodSettingsChange[] = []
    const { snapshot, unsubscribe } = service.subscribe((change) => changes.push(change))
    expect(snapshot.revision).toBe(service.get().revision)
    for (const size of [13, 14, 15, 16, 17]) {
      store.update({ terminalFontSize: size })
    }
    store.update({ terminalCursorBlink: !snapshot.values.terminalCursorBlink })
    vi.advanceTimersByTime(POD_SETTINGS_COALESCE_MS)
    expect(changes).toHaveLength(1)
    expect(changes[0].values).toEqual({
      terminalFontSize: 17,
      terminalCursorBlink: !snapshot.values.terminalCursorBlink
    })
    expect(changes[0].revision).toBe(service.get().revision)
    unsubscribe()
    expect(store.listenerCount()).toBe(0)
  })

  it('emits nothing when only secret or hidden keys change', () => {
    const { service, store } = setup()
    const changes: PodSettingsChange[] = []
    service.subscribe((change) => changes.push(change))
    store.update({ httpProxyUrl: 'http://other:pw@proxy.invalid', opencodeSessionCookie: 'x' })
    store.update({ pluginConsents: { 'a.b': 'f' }, workspaceDirHistory: [] })
    vi.advanceTimersByTime(POD_SETTINGS_COALESCE_MS * 4)
    expect(changes).toEqual([])
  })

  it('reports a field that lost its value as cleared', () => {
    const { service, store } = setup()
    store.update({ terminalPaddingX: 8 })
    const changes: PodSettingsChange[] = []
    service.subscribe((change) => changes.push(change))
    store.update({ terminalPaddingX: undefined })
    vi.advanceTimersByTime(POD_SETTINGS_COALESCE_MS)
    expect(changes).toEqual([
      expect.objectContaining({ values: {}, cleared: ['terminalPaddingX'] })
    ])
  })
})
