import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../shared/constants'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { PersistedState } from '../../shared/persisted-state-types'
import { setProductSettingDefaults } from '../../shared/product-setting-defaults'
import { normalizeLoadedGlobalSettings } from '../persistence/loading-store/normalize-loaded-global-settings'
import { prepareLoadedProfileSettings } from '../persistence/loading-store/prepare-loaded-profile-settings'
import { prepareLoadedTerminalSettings } from '../persistence/loading-store/prepare-loaded-terminal-settings'
import { parseProductIdentity } from './product-identity'
import { productSettingDefaults } from './product-setting-defaults'

const POD = parseProductIdentity(
  JSON.parse(readFileSync(join(process.cwd(), 'product', 'identity.json'), 'utf8'))
)

// Loads a stored profile the way persistence does: missing keys come from the defaults.
function loadProfile(stored: Partial<GlobalSettings>): PersistedState['settings'] {
  const defaults = getDefaultPersistedState(homedir())
  const settings: GlobalSettings = { ...defaults.settings }
  delete settings.experimentalNativeTerminal
  const parsed: PersistedState = { ...defaults, settings: { ...settings, ...stored } }
  const noop = (): void => {}
  const terminal = prepareLoadedTerminalSettings(parsed, noop)
  const profile = prepareLoadedProfileSettings(parsed, defaults, noop)
  return normalizeLoadedGlobalSettings(parsed, terminal, profile)
}

describe('product setting defaults', () => {
  afterEach(() => setProductSettingDefaults({}))

  it('turns the native terminal on only for a product build', () => {
    expect(productSettingDefaults(POD)).toEqual({ experimentalNativeTerminal: true })
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

  it('keeps a stored choice in Pod, so an explicit opt-out stays off', () => {
    setProductSettingDefaults(productSettingDefaults(POD))
    expect(loadProfile({ experimentalNativeTerminal: false }).experimentalNativeTerminal).toBe(
      false
    )
    expect(loadProfile({ experimentalNativeTerminal: true }).experimentalNativeTerminal).toBe(true)
  })
})
