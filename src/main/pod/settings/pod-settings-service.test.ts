import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState, getDefaultSettings } from '../../../shared/constants'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import {
  POD_SETTINGS_HIDDEN,
  POD_SETTINGS_SECRET_KEYS
} from '../../../shared/pod-settings-classification'
import { POD_SETTINGS_FIELDS } from '../../../shared/pod-settings-schema'
import { updateSettings } from '../../persistence/applying-settings/settings-update'
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
    await expect(service.set({ pluginConsents: {}, terminalFontSze: 3 }, revision)).rejects.toThrow(
      'podSettings.set refuses unknown keys: pluginConsents, terminalFontSze'
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
      conflictingKeys: ['terminalFontSize'],
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

  it('writes a key nobody else changed, whatever else moved since the revision', async () => {
    const { service, store, write } = setup()
    const base = service.get().revision
    store.update({ terminalFontSize: 18 })
    const result = await service.set({ theme: 'dark' }, base)
    expect(result).toMatchObject({ ok: true, values: { theme: 'dark', terminalFontSize: 18 } })
    expect(write).toHaveBeenCalledWith({ theme: 'dark' })
  })

  it('compares only the written fields of an object', async () => {
    const { service, store, write } = setup()
    const base = service.get().revision
    const notifications = store.getSettings().notifications
    store.update({ notifications: { ...notifications, enabled: false } })
    expect((await service.set({ notifications: { terminalBell: false } }, base)).ok).toBe(true)
    store.update({ notifications: { ...store.getSettings().notifications, terminalBell: true } })
    const clash = await service.set({ notifications: { terminalBell: false } }, base)
    expect(clash).toMatchObject({ ok: false, conflictingKeys: ['notifications'] })
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('counts a revision it never handed out as everything changed', async () => {
    const { service, write } = setup()
    const result = await service.set({ theme: 'dark', terminalFontSize: 15 }, 'not-a-revision')
    expect(result).toMatchObject({ ok: false, conflictingKeys: ['theme', 'terminalFontSize'] })
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
  })

  it('reads and writes per-machine mutes, keeping the other notification fields', async () => {
    const { service, write } = setup()
    expect(service.get().values.notifications).toHaveProperty('mutedNotificationSourceIds', [])
    await service.set(
      { notifications: { mutedNotificationSourceIds: ['ssh:box', 'runtime:srv'] } },
      service.get().revision
    )
    expect(write).toHaveBeenCalledWith({
      notifications: {
        ...getDefaultSettings('/Users/e2e').notifications,
        mutedNotificationSourceIds: ['ssh:box', 'runtime:srv']
      }
    })
    expect(service.get().values.notifications).toHaveProperty('mutedNotificationSourceIds', [
      'ssh:box',
      'runtime:srv'
    ])
    await expect(
      service.set(
        { notifications: { mutedNotificationSourceIds: ['nowhere'] } },
        service.get().revision
      )
    ).rejects.toThrow(PodSettingsRefusedError)
  })

  it('reads the legacy awake boolean as a mode', () => {
    const { service, store } = setup()
    store.update({ computerAwakeMode: undefined, keepComputerAwakeWhileAgentsRun: true })
    expect(service.get().values.computerAwakeMode).toBe('auto')
  })
})

describe('PodSettingsService fields that were Electron-only', () => {
  it('shows a fresh profile every field it has a default for', () => {
    const { service } = setup()
    const defaults = getDefaultSettings('/Users/e2e')
    const values = service.get().values
    for (const key of Object.keys(POD_SETTINGS_FIELDS)) {
      if (Reflect.get(defaults, key) !== undefined) {
        expect(values, key).toHaveProperty(key)
      }
    }
  })

  it('merges a partial object write into what is stored', async () => {
    const { service, store, write } = setup()
    const fixChecks = { agentId: 'codex' as const, commandInputTemplate: 'Fix {checks}' }
    store.update({
      sourceControlAi: {
        ...store.getSettings().sourceControlAi!,
        agentId: 'codex',
        actions: { fixChecks }
      },
      codexSessionSourceHome: { wsl: { Ubuntu: '/home/me/.codex' } }
    })
    const result = await service.set(
      { sourceControlAi: { enabled: true }, codexSessionSourceHome: { host: '/Users/me/.codex' } },
      service.get().revision
    )
    // The real store would normalize a bare `{ enabled }` to defaults, dropping the agent and recipes.
    expect(write).toHaveBeenCalledWith({
      sourceControlAi: expect.objectContaining({
        enabled: true,
        agentId: 'codex',
        actions: expect.objectContaining({ fixChecks })
      }),
      codexSessionSourceHome: { wsl: { Ubuntu: '/home/me/.codex' }, host: '/Users/me/.codex' }
    })
    expect(result.values.sourceControlAi).toMatchObject({ enabled: true, agentId: 'codex' })
    expect(result.values.sourceControlAi).not.toHaveProperty('actions')
    expect(result.values.codexSessionSourceHome).toEqual({ host: '/Users/me/.codex' })
  })

  it('writes a per-agent map whole, so a removed override goes', async () => {
    const { service, store, write } = setup()
    store.update({ agentCmdOverrides: { claude: 'claude-beta', codex: 'codex --profile work' } })
    await service.set({ agentCmdOverrides: { codex: 'codex' } }, service.get().revision)
    expect(write).toHaveBeenCalledWith({ agentCmdOverrides: { codex: 'codex' } })
    expect(store.getSettings().agentCmdOverrides).toEqual({ codex: 'codex' })
  })

  it('keeps a per-agent map visible when it names an agent Pod no longer has', () => {
    const { service, store } = setup()
    const agentCmdOverrides = Object.fromEntries([
      ['claude', 'claude-beta'],
      ['retired-agent', 'old']
    ])
    store.update({ agentCmdOverrides })
    expect(service.get().values.agentCmdOverrides).toEqual({ claude: 'claude-beta' })
  })

  it("compares only the written fields of source control's AI", async () => {
    const { service, store } = setup()
    const base = service.get().revision
    store.update({ sourceControlAi: { ...store.getSettings().sourceControlAi!, agentId: 'codex' } })
    expect((await service.set({ sourceControlAi: { enabled: true } }, base)).ok).toBe(true)
    const clash = await service.set({ sourceControlAi: { agentId: 'claude' } }, base)
    expect(clash).toMatchObject({ ok: false, conflictingKeys: ['sourceControlAi'] })
  })

  it("reads source control's AI as migrated from the legacy commit message key", () => {
    const { service, store } = setup()
    store.update({
      sourceControlAi: undefined,
      commitMessageAi: { ...getDefaultSettings('/Users/e2e').commitMessageAi!, enabled: true }
    })
    expect(service.get().values.sourceControlAi).toMatchObject({ enabled: true })
  })

  it("reads a terminal link click as Pod's terminal does, from the old popover switch too", () => {
    const { service, store } = setup()
    store.update({ terminalLinkClickBehavior: undefined, terminalLinkActionPopoverEnabled: false })
    expect(service.get().values.terminalLinkClickBehavior).toBe('none')
    store.update({ terminalLinkActionPopoverEnabled: true })
    expect(service.get().values.terminalLinkClickBehavior).toBe('actions')
    store.update({ terminalLinkClickBehavior: 'open', terminalLinkActionPopoverEnabled: false })
    expect(service.get().values.terminalLinkClickBehavior).toBe('open')
  })

  it('turns the old popover switch on with the actions it would hide', async () => {
    const { service, store, write } = setup()
    store.update({ terminalLinkClickBehavior: 'none', terminalLinkActionPopoverEnabled: false })
    await service.set({ terminalLinkClickBehavior: 'actions' }, service.get().revision)
    expect(write).toHaveBeenLastCalledWith({
      terminalLinkClickBehavior: 'actions',
      terminalLinkActionPopoverEnabled: true
    })
    expect(service.get().values.terminalLinkClickBehavior).toBe('actions')
  })

  it('clears the color overrides when a dark or light theme is picked, as the picker does', async () => {
    for (const key of ['terminalThemeDark', 'terminalThemeLight'] as const) {
      const { service, store, write } = setup()
      store.update({ terminalColorOverrides: { background: '#101010' } })
      await service.set({ [key]: 'Dracula' }, service.get().revision)
      expect(write, key).toHaveBeenLastCalledWith({
        [key]: 'Dracula',
        terminalColorOverrides: undefined
      })
      expect(store.getSettings().terminalColorOverrides, key).toBeUndefined()
    }
  })

  it('writes no overrides key when there are none, or for a write that picks no theme', async () => {
    const none = setup()
    await none.service.set({ terminalThemeDark: 'Dracula' }, none.service.get().revision)
    expect(none.write).toHaveBeenLastCalledWith({ terminalThemeDark: 'Dracula' })
    const other = setup()
    other.store.update({ terminalColorOverrides: { background: '#101010' } })
    await other.service.set({ terminalFontSize: 15 }, other.service.get().revision)
    expect(other.write).toHaveBeenLastCalledWith({ terminalFontSize: 15 })
    expect(other.store.getSettings().terminalColorOverrides).toEqual({ background: '#101010' })
  })

  it('drops the overrides from what the store keeps and saves, through its own update', async () => {
    const state = getDefaultPersistedState('/Users/e2e')
    state.settings = {
      ...state.settings,
      terminalColorOverrides: { background: '#101010', red: '#ff0000' }
    }
    const operations = {
      state,
      bumpLocalWorktreeScanGeneration: vi.fn(),
      removeRetainedBlob: vi.fn(),
      scheduleSave: vi.fn(),
      notifySettingsChanged: vi.fn()
    }
    const store = {
      getSettings: () => operations.state.settings,
      onSettingsChanged: () => () => {}
    }
    const service = new PodSettingsService(store, async (values) =>
      updateSettings(operations, values, { notifyListeners: true })
    )
    await service.set({ terminalThemeDark: 'Dracula' }, service.get().revision)
    expect(operations.state.settings.terminalThemeDark).toBe('Dracula')
    expect(operations.state.settings.terminalColorOverrides).toBeUndefined()
    // What the profile saves: JSON, which leaves the key out.
    expect('terminalColorOverrides' in JSON.parse(JSON.stringify(operations.state.settings))).toBe(
      false
    )
    expect(operations.scheduleSave).toHaveBeenCalled()
    // The runtime's terminal theme hears of it (RUNTIME_TERMINAL_THEME_SETTING_KEYS).
    const [changed] = operations.notifySettingsChanged.mock.lastCall ?? []
    expect('terminalColorOverrides' in (changed ?? {})).toBe(true)
  })

  it("refuses values the desktop's own controls can't produce", async () => {
    const { service, write } = setup()
    const { revision } = service.get()
    for (const values of [
      { terminalFontSize: 500 },
      { promptCacheTtlMs: 60_000 },
      { httpProxyBypassRules: 'x'.repeat(4097) },
      { agentCmdOverrides: { 'not-an-agent': 'x' } },
      { terminalScrollSensitivity: 11 },
      // Hidden as `later` until PodNative applies them: not writable meanwhile.
      { terminalShortcutPolicy: 'terminal-first' },
      { openInApplications: [] }
    ]) {
      await expect(service.set(values, revision), JSON.stringify(values)).rejects.toThrow(
        PodSettingsRefusedError
      )
    }
    expect(write).not.toHaveBeenCalled()
  })
})

describe('PodSettingsService network proxy', () => {
  it("reads the proxy as Pod's network settings show it", () => {
    const { service, store } = setup()
    store.update({ httpProxyBypassRules: 'localhost;*.internal' })
    expect(service.networkProxy()).toEqual({
      httpProxyUrl: SECRETS.httpProxyUrl,
      httpProxyBypassRules: 'localhost;*.internal'
    })
  })

  it('writes a valid URL in the form the settings pane stores', async () => {
    const { service, write } = setup()
    await expect(
      service.setNetworkProxy('  socks5://proxy.example.invalid:1080  ')
    ).resolves.toEqual({
      httpProxyUrl: 'socks5://proxy.example.invalid:1080',
      httpProxyBypassRules: ''
    })
    expect(write).toHaveBeenCalledWith({ httpProxyUrl: 'socks5://proxy.example.invalid:1080' })
  })

  it("refuses what the pane refuses, with the pane's message, and keeps the stored proxy", async () => {
    const { service, store, write } = setup()
    await expect(service.setNetworkProxy('ftp://proxy.example.invalid')).rejects.toThrow(
      'Use an http, https, socks, socks4, or socks5 proxy URL.'
    )
    await expect(service.setNetworkProxy('not a url')).rejects.toThrow('Enter a valid proxy URL.')
    expect(write).not.toHaveBeenCalled()
    expect(store.getSettings().httpProxyUrl).toBe(SECRETS.httpProxyUrl)
  })

  it('clears the proxy with an empty URL', async () => {
    const { service, write } = setup()
    await expect(service.setNetworkProxy('')).resolves.toMatchObject({ httpProxyUrl: '' })
    expect(write).toHaveBeenCalledWith({ httpProxyUrl: '' })
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

  it('reports a failed read and keeps following', () => {
    const { service, store } = setup()
    const changes: PodSettingsChange[] = []
    const errors: string[] = []
    service.subscribe(
      (change) => changes.push(change),
      (message) => errors.push(message)
    )
    const read = store.getSettings
    store.getSettings = () => {
      throw new Error('profile unreadable')
    }
    store.update({ terminalFontSize: 19 })
    vi.advanceTimersByTime(POD_SETTINGS_COALESCE_MS)
    expect(errors).toEqual(['profile unreadable'])
    store.getSettings = read
    store.update({ terminalFontSize: 20 })
    vi.advanceTimersByTime(POD_SETTINGS_COALESCE_MS)
    expect(changes.map((change) => change.values.terminalFontSize)).toEqual([20])
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
