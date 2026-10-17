import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../shared/constants'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { PersistedState } from '../../shared/persisted-state-types'
import { setProductSettingDefaults } from '../../shared/product-setting-defaults'
import { normalizeLoadedGlobalSettings } from '../persistence/loading-store/normalize-loaded-global-settings'
import { normalizeLoadedProfileState } from '../persistence/loading-store/normalize-loaded-profile-state'
import { prepareLoadedProfileSettings } from '../persistence/loading-store/prepare-loaded-profile-settings'
import { prepareLoadedTerminalSettings } from '../persistence/loading-store/prepare-loaded-terminal-settings'
import { parseProductIdentity } from './product-identity'
import { productSettingDefaults } from './product-setting-defaults'
import { isMainTerminalModelDormancyEnabled } from '../pod/pod-terminal-model-dormancy'

const POD = parseProductIdentity(
  JSON.parse(readFileSync(join(process.cwd(), 'product', 'identity.json'), 'utf8'))
)

// Loads a stored profile the way persistence does: missing keys come from the defaults.
function loadProfile(stored: Partial<GlobalSettings>): PersistedState['settings'] {
  const defaults = getDefaultPersistedState(homedir())
  const settings: GlobalSettings = { ...defaults.settings, ...stored }
  for (const key of [
    'experimentalNativeTerminal',
    'terminalCursorBlink',
    'podTerminalMainModelDormancy'
  ] as const) {
    if (!(key in stored)) {
      Reflect.deleteProperty(settings, key)
    }
  }
  const parsed: PersistedState = { ...defaults, settings }
  const noop = (): void => {}
  const terminal = prepareLoadedTerminalSettings(parsed, noop)
  const profile = prepareLoadedProfileSettings(parsed, defaults, noop)
  return normalizeLoadedGlobalSettings(parsed, terminal, profile)
}

// The whole load, product flips included: missing keys stay missing, as in an Orca profile.
function loadProfileState(stored: Partial<GlobalSettings>): {
  settings: PersistedState['settings']
  needsSave: boolean
} {
  const defaults = getDefaultPersistedState(homedir())
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a stored profile may lack any key; the loader fills them in.
  const parsed: PersistedState = { ...defaults, settings: stored as GlobalSettings }
  let needsSave = false
  const markNeedsSave = (): void => {
    needsSave = true
  }
  const terminal = prepareLoadedTerminalSettings(parsed, () => {})
  const profile = prepareLoadedProfileSettings(parsed, defaults, () => {})
  const { settings } = normalizeLoadedProfileState(parsed, terminal, profile, markNeedsSave)
  return { settings, needsSave }
}

describe('product setting defaults', () => {
  afterEach(() => setProductSettingDefaults({}))

  it('turns the native terminal on and cursor blink off only for a product build', () => {
    expect(productSettingDefaults(POD)).toEqual({
      experimentalNativeTerminal: true,
      terminalCursorBlink: false,
      podTerminalMainModelDormancy: false,
      tabAutoGenerateTitle: true,
      tabAutoGenerateTitleDefaultedOnForPod: true
    })
    expect(productSettingDefaults(null)).toEqual({})
  })

  it('leaves upstream Orca off by default, for fresh and loaded profiles', () => {
    setProductSettingDefaults(productSettingDefaults(null))
    expect(getDefaultPersistedState(homedir()).settings.experimentalNativeTerminal).toBe(false)
    expect(loadProfile({}).experimentalNativeTerminal).toBe(false)
  })

  it('turns it on in Pod for a fresh profile and an Orca profile that never had the key', () => {
    setProductSettingDefaults(productSettingDefaults(POD))
    expect(getDefaultPersistedState(homedir()).settings.experimentalNativeTerminal).toBe(true)
    expect(loadProfile({}).experimentalNativeTerminal).toBe(true)
  })

  it('defaults cursor blink off in Pod only where the profile has no stored choice', () => {
    setProductSettingDefaults(productSettingDefaults(POD))
    expect(getDefaultPersistedState(homedir()).settings.terminalCursorBlink).toBe(false)
    expect(loadProfile({}).terminalCursorBlink).toBe(false)
    expect(loadProfile({ terminalCursorBlink: true }).terminalCursorBlink).toBe(true)
    setProductSettingDefaults(productSettingDefaults(null))
    expect(loadProfile({}).terminalCursorBlink).toBe(true)
  })

  // Why: earlier Pod builds stored Orca's old default `terminalMainModelDormancy: true`.
  it("keeps main's terminal model live in Pod, even where a profile stored Orca's default on", () => {
    setProductSettingDefaults(productSettingDefaults(POD))
    const loaded = loadProfile({ terminalMainModelDormancy: true })
    expect(loaded.podTerminalMainModelDormancy).toBe(false)
    expect(isMainTerminalModelDormancyEnabled(loaded)).toBe(false)
    expect(
      isMainTerminalModelDormancyEnabled(loadProfile({ podTerminalMainModelDormancy: true }))
    ).toBe(true)
    setProductSettingDefaults(productSettingDefaults(null))
    expect(isMainTerminalModelDormancyEnabled(loadProfile({}))).toBe(true)
    expect(
      isMainTerminalModelDormancyEnabled(loadProfile({ terminalMainModelDormancy: false }))
    ).toBe(false)
  })

  it('keeps a stored choice in Pod, so an explicit opt-out stays off', () => {
    setProductSettingDefaults(productSettingDefaults(POD))
    expect(loadProfile({ experimentalNativeTerminal: false }).experimentalNativeTerminal).toBe(
      false
    )
    expect(loadProfile({ experimentalNativeTerminal: true }).experimentalNativeTerminal).toBe(true)
  })

  it('turns generated tab titles on in Pod for a fresh profile', () => {
    setProductSettingDefaults(productSettingDefaults(POD))
    expect(getDefaultPersistedState(homedir()).settings).toMatchObject({
      tabAutoGenerateTitle: true,
      tabAutoGenerateTitleDefaultedOnForPod: true
    })
  })

  // Why: Orca stored its default false in every profile, so a false from before the flip is no choice.
  it('flips a stored false once in Pod, and saves the flip', () => {
    setProductSettingDefaults(productSettingDefaults(POD))
    const first = loadProfileState({ tabAutoGenerateTitle: false })
    expect(first.settings.tabAutoGenerateTitle).toBe(true)
    expect(first.settings.tabAutoGenerateTitleDefaultedOnForPod).toBe(true)
    expect(first.needsSave).toBe(true)
  })

  it('keeps an off chosen after the flip', () => {
    setProductSettingDefaults(productSettingDefaults(POD))
    const again = loadProfileState({
      tabAutoGenerateTitle: false,
      tabAutoGenerateTitleDefaultedOnForPod: true
    })
    expect(again.settings.tabAutoGenerateTitle).toBe(false)
    expect(again.settings.tabAutoGenerateTitleDefaultedOnForPod).toBe(true)
    expect(
      loadProfileState({ tabAutoGenerateTitle: true, tabAutoGenerateTitleDefaultedOnForPod: true })
        .settings.tabAutoGenerateTitle
    ).toBe(true)
  })

  it('leaves upstream Orca titles off and never flips them', () => {
    setProductSettingDefaults(productSettingDefaults(null))
    expect(getDefaultPersistedState(homedir()).settings.tabAutoGenerateTitle).toBe(false)
    const loaded = loadProfileState({ tabAutoGenerateTitle: false })
    expect(loaded.settings.tabAutoGenerateTitle).toBe(false)
    expect(loaded.settings.tabAutoGenerateTitleDefaultedOnForPod).toBeUndefined()
  })
})
