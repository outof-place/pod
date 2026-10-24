import { describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { PodSettingsReadOnlySchema } from '../../../shared/pod-settings-read-only'
import type { TerminalCustomTheme } from '../../../shared/terminal-custom-themes'
import { updateSettings } from '../../persistence/applying-settings/settings-update'
import {
  POD_SETTINGS_COALESCE_MS,
  PodSettingsRefusedError,
  PodSettingsService,
  type PodSettingsChange
} from './pod-settings-service'

/** The store's own update path (settings-update.ts), with its listeners, as settings:set reaches it. */
function setup(settings: Partial<GlobalSettings> = {}) {
  const state = getDefaultPersistedState('/Users/e2e')
  state.settings = { ...state.settings, ...settings }
  const listeners = new Set<(updates: Partial<GlobalSettings>) => void>()
  const operations = {
    state,
    bumpLocalWorktreeScanGeneration: vi.fn(),
    removeRetainedBlob: vi.fn(),
    scheduleSave: vi.fn(),
    notifySettingsChanged: (updates: Partial<GlobalSettings>) => {
      for (const listener of listeners) {
        listener(updates)
      }
    }
  }
  const store = {
    getSettings: () => operations.state.settings,
    onSettingsChanged: (listener: (updates: Partial<GlobalSettings>) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  const write = vi.fn(async (values: Partial<GlobalSettings>) =>
    updateSettings(operations, values, { notifyListeners: true })
  )
  return { operations, write, service: new PodSettingsService(store, write) }
}

const dusk: TerminalCustomTheme = {
  id: 'warp:dusk',
  name: 'Dusk',
  source: 'warp',
  mode: 'dark',
  terminal: { background: '#101010', foreground: '#f0f0f0', red: '#ff0000' },
  importedAt: '2026-10-20T00:00:00.000Z'
}

describe('the terminal color overrides over podSettings', () => {
  it('writes them whole, as #rrggbb, and shows what is stored', async () => {
    const { operations, service } = setup()
    const result = await service.set(
      { terminalColorOverrides: { background: '#ABC', red: 'FF0000' } },
      service.get().revision
    )
    expect(operations.state.settings.terminalColorOverrides).toEqual({
      background: '#aabbcc',
      red: '#ff0000'
    })
    expect(result).toMatchObject({
      ok: true,
      values: { terminalColorOverrides: { background: '#aabbcc', red: '#ff0000' } }
    })
    // Whole: a key left out is gone, and {} clears them all.
    await service.set({ terminalColorOverrides: { red: '#00ff00' } }, service.get().revision)
    expect(operations.state.settings.terminalColorOverrides).toEqual({ red: '#00ff00' })
    await service.set({ terminalColorOverrides: {} }, service.get().revision)
    expect(operations.state.settings.terminalColorOverrides).toEqual({})
    expect(service.get().values.terminalColorOverrides).toEqual({})
  })

  it('refuses a color that is not hex, or a key that names no color, and writes nothing', async () => {
    const { write, service } = setup()
    for (const terminalColorOverrides of [
      { background: 'red' },
      { background: '#12345' },
      { background: 'rgb(1, 2, 3)' },
      { purple: '#800080' }
    ]) {
      await expect(
        service.set({ terminalColorOverrides }, service.get().revision),
        JSON.stringify(terminalColorOverrides)
      ).rejects.toThrow(PodSettingsRefusedError)
    }
    expect(write).not.toHaveBeenCalled()
  })

  it('shows the valid colors of what an import stored, not none', () => {
    const { service } = setup({
      terminalColorOverrides: { background: 'not-a-color', foreground: '#FFF' }
    })
    expect(service.get().values.terminalColorOverrides).toEqual({ foreground: '#ffffff' })
  })

  it('a theme picked over podSettings.set clears them, and a subscriber hears they went', async () => {
    vi.useFakeTimers()
    try {
      const { operations, service } = setup({ terminalColorOverrides: { background: '#101010' } })
      const changes: PodSettingsChange[] = []
      service.subscribe((change) => changes.push(change))
      await service.set({ terminalThemeDark: 'Dracula' }, service.get().revision)
      vi.advanceTimersByTime(POD_SETTINGS_COALESCE_MS * 2)
      expect(operations.state.settings.terminalColorOverrides).toBeUndefined()
      expect(changes.at(-1)?.cleared).toContain('terminalColorOverrides')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the custom terminal themes in podSettings readOnly', () => {
  it("lists each usable theme's selection, name and source, and set refuses them", async () => {
    const unusable = { ...dusk, id: 'warp:flat', name: 'Flat', terminal: { background: '#000000' } }
    const { write, service } = setup({ terminalCustomThemes: [dusk, unusable] })
    expect(service.get().readOnly.terminalCustomThemes).toEqual([
      { selection: 'custom:warp:dusk', name: 'Dusk', source: 'warp' }
    ])
    await expect(service.set({ terminalCustomThemes: [] }, service.get().revision)).rejects.toThrow(
      PodSettingsRefusedError
    )
    expect(write).not.toHaveBeenCalled()
  })

  it('bounds a name, and leaves out a theme whose selection the theme fields would refuse', () => {
    const long = { ...dusk, id: 'warp:long', name: `${'🌙'.repeat(300)}` }
    const tooLong = { ...dusk, id: `warp:${'x'.repeat(300)}`, name: 'Too long' }
    const { service } = setup({ terminalCustomThemes: [long, tooLong] })
    const [shown, ...rest] = service.get().readOnly.terminalCustomThemes
    expect(rest).toEqual([])
    expect(shown.selection).toBe('custom:warp:long')
    // 256 UTF-16 units, as the schema counts: 128 moons of two each.
    expect(shown.name).toBe('🌙'.repeat(128))
    expect(PodSettingsReadOnlySchema.safeParse(service.get().readOnly).success).toBe(true)
  })

  it('never cuts a surrogate pair in half to bound a name', () => {
    const odd = { ...dusk, id: 'warp:odd', name: `a${'🌙'.repeat(200)}` }
    const { service } = setup({ terminalCustomThemes: [odd] })
    const [shown] = service.get().readOnly.terminalCustomThemes
    // 'a' and 127 moons are 255 units; one more moon would be 257.
    expect(shown.name).toBe(`a${'🌙'.repeat(127)}`)
    expect(PodSettingsReadOnlySchema.safeParse(service.get().readOnly).success).toBe(true)
  })

  it('a picked custom theme is a selection the theme fields take', async () => {
    const { operations, service } = setup({ terminalCustomThemes: [dusk] })
    const [theme] = service.get().readOnly.terminalCustomThemes
    await service.set({ terminalThemeDark: theme.selection }, service.get().revision)
    expect(operations.state.settings.terminalThemeDark).toBe('custom:warp:dusk')
    expect(service.get().values.terminalThemeDark).toBe('custom:warp:dusk')
  })

  it('an import elsewhere reaches a subscriber as a readOnly change', () => {
    vi.useFakeTimers()
    try {
      const { operations, service } = setup()
      const changes: PodSettingsChange[] = []
      service.subscribe((change) => changes.push(change))
      updateSettings(operations, { terminalCustomThemes: [dusk] }, { notifyListeners: true })
      vi.advanceTimersByTime(POD_SETTINGS_COALESCE_MS * 2)
      expect(changes.at(-1)?.readOnly?.terminalCustomThemes).toEqual([
        { selection: 'custom:warp:dusk', name: 'Dusk', source: 'warp' }
      ])
    } finally {
      vi.useRealTimers()
    }
  })
})
