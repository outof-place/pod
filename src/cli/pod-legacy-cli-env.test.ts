import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ENV_DECOUPLED, ENV_SPELLINGS } from '../shared/pod-legacy-env-names'
import { adoptLegacyCliEnv } from './pod-legacy-cli-env'

// Fork-only (Pod): podx in a terminal opened before the decouple update; Orca.app's terminals
// have ORCA_ names too, naming Orca's runtime and token.
const current = (name: string): string => `${ENV_SPELLINGS.current}${name}`
const legacy = (name: string): string => `${ENV_SPELLINGS.legacy}${name}`

// Spelled /tmp while it resolves to /private/tmp: both sides are compared resolved.
const home = mkdtempSync('/tmp/pod-legacy-cli-env-')
const support = join(home, 'Library', 'Application Support')
for (const folder of ['Pod/profile', 'Pod Dev', 'Pod2', 'orca']) {
  mkdirSync(join(support, folder), { recursive: true })
}
symlinkSync(join(support, 'orca'), join(support, 'Pod', 'to-orca'))
afterAll(() => rmSync(home, { recursive: true, force: true }))

function terminal(userData: string): NodeJS.ProcessEnv {
  return {
    [legacy('USER_DATA_PATH')]: join(support, userData),
    [legacy('TERMINAL_HANDLE')]: 'term-1',
    HOME: home
  }
}

describe.runIf(ENV_DECOUPLED)('podx in a terminal with ORCA_ names', () => {
  it.each(['Pod', 'Pod/profile'])("runs on a Pod terminal's names (%s)", (userData) => {
    const env = terminal(userData)
    const errors: string[] = []
    expect(adoptLegacyCliEnv(env, (line) => errors.push(line))).toBe(true)
    expect(env[current('USER_DATA_PATH')]).toBe(join(support, userData))
    expect(env[current('TERMINAL_HANDLE')]).toBe('term-1')
    expect(errors).toEqual([])
  })

  // Orca.app's terminal, a dev Pod's, one whose name only starts with Pod's, and a symlink out of
  // Pod's folder into Orca's.
  it.each(['orca', 'Pod Dev', 'Pod2', 'Pod/to-orca'])(
    "refuses another app's runtime (%s)",
    (userData) => {
      const env = terminal(userData)
      const errors: string[] = []
      expect(adoptLegacyCliEnv(env, (line) => errors.push(line))).toBe(false)
      expect(env[current('USER_DATA_PATH')]).toBeUndefined()
      expect(env[current('TERMINAL_HANDLE')]).toBeUndefined()
      expect(errors).toEqual([
        `podx: no Pod runtime in env: ${legacy('USER_DATA_PATH')} is another app's data (${join(support, userData)})\n`
      ])
    }
  )

  it("runs when the env also names Pod's runtime itself", () => {
    const env = { ...terminal('orca'), [current('USER_DATA_PATH')]: join(support, 'Pod') }
    expect(adoptLegacyCliEnv(env, () => {})).toBe(true)
    expect(env[current('USER_DATA_PATH')]).toBe(join(support, 'Pod'))
    expect(env[current('TERMINAL_HANDLE')]).toBeUndefined()
  })
})
