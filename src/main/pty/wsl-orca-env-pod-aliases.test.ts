// Fork-only (Pod): every POD_ alias crosses into WSL next to its ORCA_ name (pod-env-aliases.ts).
import { describe, expect, it } from 'vitest'
import { POD_ALIASED_ORCA_ENV_NAMES, podSpellingOf } from '../../shared/pod-env-aliases'
import { addOrcaWslInteropEnv } from './wsl-orca-env'

const WINDOWS_ENV_VALUE_LIMIT = 32_767

describe('addOrcaWslInteropEnv POD_ aliases', () => {
  it('forwards each aliased name under both spellings with the same flag', () => {
    const env: Record<string, string> = {
      ORCA_PANE_KEY: 'tab-1:leaf-1',
      ORCA_AGENT_HOOK_ENDPOINT: 'C:\\Users\\jin\\AppData\\Roaming\\Pod\\agent-hooks\\endpoint.cmd'
    }
    addOrcaWslInteropEnv(env)
    const entries = env.WSLENV.split(':')
    expect(entries).toContain('ORCA_PANE_KEY/u')
    expect(entries).toContain('POD_PANE_KEY/u')
    expect(entries).toContain('ORCA_AGENT_HOOK_ENDPOINT/p')
    expect(entries).toContain('POD_AGENT_HOOK_ENDPOINT/p')
    for (const entry of entries.filter((value) => value.startsWith('ORCA_'))) {
      const [name, flag] = entry.split('/')
      if (POD_ALIASED_ORCA_ENV_NAMES.includes(name)) {
        expect(entries, name).toContain(`${podSpellingOf(name)}/${flag}`)
      }
    }
  })

  it('stays within the Windows variable limit with every forwarded name set', () => {
    const env: Record<string, string> = {}
    for (const name of POD_ALIASED_ORCA_ENV_NAMES) {
      env[name] = 'C:\\value'
    }
    addOrcaWslInteropEnv(env)
    expect(env.WSLENV.length).toBeLessThan(WINDOWS_ENV_VALUE_LIMIT)
  })
})
