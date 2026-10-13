import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildLocalPtySpawnEnvironment } from './local-pty-spawn-environment'
import type { LocalPtyLaunchPlan } from './local-pty-launch-plan'

const plan: LocalPtyLaunchPlan = {
  startupAgentRecognition: null,
  defaultCwd: '',
  cwd: '',
  wslInfo: null,
  worktreeWslContext: undefined,
  preferredWslContext: undefined,
  launchWslContext: undefined,
  shellPath: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
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

describe("a local terminal and the runtime's http hook A/B", () => {
  it('does not pass POD_CLAUDE_HTTP_HOOKS on to a Pod started in the terminal', async () => {
    vi.stubEnv('POD_CLAUDE_HTTP_HOOKS', '1')
    vi.stubEnv('KEEP_ME', 'runtime-value')
    const env = await buildLocalPtySpawnEnvironment({
      id: 'new-terminal',
      spawn: { cols: 80, rows: 24, env: { ORCA_PANE_KEY: 'tab:leaf' } },
      getOptions: () => ({}),
      plan
    })
    expect(env.POD_CLAUDE_HTTP_HOOKS).toBeUndefined()
    expect(env).toMatchObject({ KEEP_ME: 'runtime-value', ORCA_PANE_KEY: 'tab:leaf' })
    // The runtime itself keeps it: its own next template write still reads it.
    expect(process.env.POD_CLAUDE_HTTP_HOOKS).toBe('1')
  })
})
