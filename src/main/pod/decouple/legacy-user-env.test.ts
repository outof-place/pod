import { describe, expect, it } from 'vitest'
import { ENV_DECOUPLED, ENV_SPELLINGS } from '../../../shared/pod-legacy-env-names'
import { RENAMED_ENV_NAMES } from '../../../shared/pod-renamed-env-names'
import { adoptLegacyUserEnv, LEGACY_USER_ENV_NAMES } from './legacy-user-env'

// Names built from the two prefixes, so the codemod leaves this test's meaning alone.
const current = (name: string): string => `${ENV_SPELLINGS.current}${name}`
const legacy = (name: string): string => `${ENV_SPELLINGS.legacy}${name}`

describe('the app process takes a user ORCA_ setting for one release', () => {
  it('lists only names the decouple renames', () => {
    const renamed = new Set<string>(RENAMED_ENV_NAMES)
    expect(LEGACY_USER_ENV_NAMES.filter((name) => !renamed.has(name))).toEqual([])
  })

  it('never lists a terminal-scoped name', () => {
    const scoped = [
      'PANE_KEY',
      'TAB_ID',
      'WORKTREE_ID',
      'AGENT_HOOK_ENDPOINT',
      'AGENT_LAUNCH_TOKEN'
    ]
    for (const name of scoped) {
      expect(LEGACY_USER_ENV_NAMES as readonly string[]).not.toContain(current(name))
      expect(LEGACY_USER_ENV_NAMES as readonly string[]).not.toContain(legacy(name))
    }
  })

  it("never takes the CLI install path, which names the legacy app's CLI", () => {
    expect(LEGACY_USER_ENV_NAMES as readonly string[]).not.toContain(current('CLI_INSTALL_PATH'))
    expect(LEGACY_USER_ENV_NAMES as readonly string[]).not.toContain(legacy('CLI_INSTALL_PATH'))
  })

  it.runIf(ENV_DECOUPLED)('takes the ORCA_ value only where the POD_ spelling is unset', () => {
    const env: NodeJS.ProcessEnv = {
      [legacy('GITEA_TOKEN')]: 'old-token',
      [legacy('TELEMETRY_DISABLED')]: '1',
      [current('TELEMETRY_DISABLED')]: '0',
      [legacy('PANE_KEY')]: 'tab-9:parent-pane'
    }

    expect(adoptLegacyUserEnv(env)).toEqual([current('GITEA_TOKEN')])

    expect(env[current('GITEA_TOKEN')]).toBe('old-token')
    expect(env[current('TELEMETRY_DISABLED')]).toBe('0')
    expect(env[current('PANE_KEY')]).toBeUndefined()
    expect(adoptLegacyUserEnv(env)).toEqual([])
  })

  it.skipIf(ENV_DECOUPLED)('changes nothing before the codemod', () => {
    const env: NodeJS.ProcessEnv = { [legacy('GITEA_TOKEN')]: 'token' }
    expect(adoptLegacyUserEnv(env)).toEqual([])
    expect(env).toEqual({ [legacy('GITEA_TOKEN')]: 'token' })
  })
})
