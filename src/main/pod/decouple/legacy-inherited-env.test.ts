import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDaemonPtyEnvironment } from '../../daemon/pty-subprocess/spawn-environment'
import type { LocalPtyLaunchPlan } from '../../providers/local-pty-launch-plan'
import { buildLocalPtySpawnEnvironment } from '../../providers/local-pty-spawn-environment'
import { ENV_DECOUPLED, ENV_SPELLINGS } from '../../../shared/pod-legacy-env-names'

// Fork-only (Pod): a runtime or daemon started from a live pre-decouple Pod's pane inherits that
// pane's ORCA_ env. The dual-read hook clients would take it for this runtime's own.
const current = (name: string): string => `${ENV_SPELLINGS.current}${name}`
const legacy = (name: string): string => `${ENV_SPELLINGS.legacy}${name}`

const INHERITED = {
  [legacy('AGENT_HOOK_ENDPOINT')]: '/live-pod/agent-hooks/endpoint.env',
  [legacy('PANE_KEY')]: 'tab-9:live-pane',
  [legacy('AGENT_LAUNCH_TOKEN')]: 'live-launch'
}
// A dev receiver without an endpoint file: no endpoint, its own pane.
const DEV_REQUEST = {
  [current('AGENT_HOOK_ENV')]: 'development',
  [current('PANE_KEY')]: 'tab-1:dev-pane',
  [legacy('TAB_ID')]: 'explicit-legacy'
}
const plan: LocalPtyLaunchPlan = {
  startupAgentRecognition: null,
  defaultCwd: '',
  cwd: '',
  wslInfo: null,
  worktreeWslContext: undefined,
  preferredWslContext: undefined,
  launchWslContext: undefined,
  shellPath: '/bin/sh',
  shellArgs: [],
  effectiveCwd: '',
  validationCwd: '',
  startupCommandDeliveredInShellArgs: false,
  windowsFallbackAttempts: [],
  shellReadyLaunch: null,
  getFallbackShellReadyConfig: undefined,
  primaryPreLaunchEnv: {},
  isWslShell: false,
  launchWslDistro: null
}

afterEach(() => vi.unstubAllEnvs())

describe.runIf(ENV_DECOUPLED)('a new terminal under an env inherited from a live Pod', () => {
  it.each(['daemon', 'local'] as const)(
    'gets none of its inherited ORCA_ values on the %s path, only twins of its own',
    async (path) => {
      for (const [name, value] of Object.entries(INHERITED)) {
        vi.stubEnv(name, value)
      }
      const env =
        path === 'daemon'
          ? createDaemonPtyEnvironment({ sessionId: 's', cols: 80, rows: 24, env: DEV_REQUEST })
          : await buildLocalPtySpawnEnvironment({
              id: 's',
              spawn: { cols: 80, rows: 24, env: DEV_REQUEST },
              getOptions: () => ({}),
              plan
            })
      // The inherited values never reach the pane; the ORCA_ twins carry this request's own.
      expect(env[legacy('AGENT_HOOK_ENDPOINT')]).toBeUndefined()
      expect(env[legacy('AGENT_LAUNCH_TOKEN')]).toBeUndefined()
      expect(env[current('AGENT_HOOK_ENDPOINT')]).toBeUndefined()
      expect(env[current('PANE_KEY')]).toBe('tab-1:dev-pane')
      expect(env[legacy('PANE_KEY')]).toBe('tab-1:dev-pane')
      expect(env[legacy('AGENT_HOOK_ENV')]).toBe('development')
      expect(env[legacy('TAB_ID')]).toBe('explicit-legacy')
    }
  )
})
