import { describe, expect, it } from 'vitest'
import {
  adoptLegacyEnvNames,
  ENV_DECOUPLED,
  ENV_SPELLINGS,
  legacyEnvName,
  renamedLegacyEnvName
} from './pod-legacy-env-names'

const current = (name: string): string => `${ENV_SPELLINGS.current}${name}`
const legacy = (name: string): string => `${ENV_SPELLINGS.legacy}${name}`

describe('the env names on both sides of the decouple', () => {
  it('spells a POD_ name the ORCA_ way, and nothing else', () => {
    expect(legacyEnvName(current('TERMINAL_HANDLE'))).toBe(legacy('TERMINAL_HANDLE'))
    expect(legacyEnvName(legacy('TERMINAL_HANDLE'))).toBeNull()
    expect(legacyEnvName('HISTFILE')).toBeNull()
  })

  it.runIf(!ENV_DECOUPLED)('changes nothing before the codemod', () => {
    const env = { [legacy('PANE_KEY')]: 'tab-1:old', HOME: '/h' }
    adoptLegacyEnvNames(env)
    expect(env).toEqual({ [legacy('PANE_KEY')]: 'tab-1:old', HOME: '/h' })
  })
})

describe.runIf(ENV_DECOUPLED)('the overlap after the codemod', () => {
  it('spells only the renamed names the ORCA_ way', () => {
    expect(renamedLegacyEnvName(current('TERMINAL_HANDLE'))).toBe(legacy('TERMINAL_HANDLE'))
    // Fork-only names were POD_ before the decouple too.
    expect(renamedLegacyEnvName(current('AGENT_TREE'))).toBeNull()
    expect(renamedLegacyEnvName(legacy('TERMINAL_HANDLE'))).toBeNull()
  })

  it("gives the CLI in an old terminal the renamed POD_ names, without overriding the pane's own", () => {
    const env: Record<string, string | undefined> = {
      [legacy('TERMINAL_HANDLE')]: 'term-old',
      [legacy('PANE_KEY')]: 'tab-1:old',
      [current('PANE_KEY')]: 'tab-1:new',
      // A kept name: the CLI must not turn it into the fork's own POD_ name.
      [legacy('E2E_USER_DATA_DIR')]: '/e2e',
      HOME: '/h'
    }
    adoptLegacyEnvNames(env)
    expect(env).toEqual({
      [legacy('TERMINAL_HANDLE')]: 'term-old',
      [current('TERMINAL_HANDLE')]: 'term-old',
      [legacy('PANE_KEY')]: 'tab-1:old',
      [current('PANE_KEY')]: 'tab-1:new',
      [legacy('E2E_USER_DATA_DIR')]: '/e2e',
      HOME: '/h'
    })
  })
})
