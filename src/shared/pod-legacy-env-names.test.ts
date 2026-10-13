import { describe, expect, it } from 'vitest'
import { adoptLegacyEnvNames, ENV_SPELLINGS, legacyEnvName } from './pod-legacy-env-names'

const current = (name: string): string => `${ENV_SPELLINGS.current}${name}`
const legacy = (name: string): string => `${ENV_SPELLINGS.legacy}${name}`

describe('the env names on both sides of the decouple', () => {
  it('spells a POD_ name the ORCA_ way, and nothing else', () => {
    expect(legacyEnvName(current('TERMINAL_HANDLE'))).toBe(legacy('TERMINAL_HANDLE'))
    expect(legacyEnvName(legacy('TERMINAL_HANDLE'))).toBeNull()
    expect(legacyEnvName('HISTFILE')).toBeNull()
  })

  it("gives the CLI in an old terminal the POD_ names, without overriding the pane's own", () => {
    const env: Record<string, string | undefined> = {
      [legacy('TERMINAL_HANDLE')]: 'term-old',
      [legacy('PANE_KEY')]: 'tab-1:old',
      [current('PANE_KEY')]: 'tab-1:new',
      HOME: '/h'
    }
    adoptLegacyEnvNames(env)
    expect(env).toEqual({
      [legacy('TERMINAL_HANDLE')]: 'term-old',
      [current('TERMINAL_HANDLE')]: 'term-old',
      [legacy('PANE_KEY')]: 'tab-1:old',
      [current('PANE_KEY')]: 'tab-1:new',
      HOME: '/h'
    })
  })
})
