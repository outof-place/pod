import '../../daemon/mock-descendant-sweep'
import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DaemonClient } from '../../daemon/client'
import type { DaemonEndpointIdentity } from '../../daemon/daemon-hello-protocol'
import type { TerminalHostOptions } from '../../daemon/terminal-host-options'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  type DaemonAdapterHarness
} from '../../daemon/daemon-pty-adapter-test-harness'
import { ENV_DECOUPLED } from '../../../shared/pod-legacy-env-names'
import {
  daemonReadsLegacyEnv,
  spawnOptionsForDaemon,
  TERMINAL_HANDLE_ENV,
  withLegacyEnvTwins,
  withLegacyEnvTwinsToDelete
} from './legacy-daemon-env'

// Names built from the two prefixes, so the codemod leaves this test's meaning alone.
const SPELLINGS = { legacy: 'ORCA_', current: 'POD_' } as const // pod-decouple:keep
const current = (name: string): string => `${SPELLINGS.current}${name}`
const legacy = (name: string): string => `${SPELLINGS.legacy}${name}`

const IDENTITY: DaemonEndpointIdentity = { pid: 42, startedAtMs: 1, launchNonce: 'n' }
// The server's callback type omits envToDelete, which the terminal host passes it anyway.
type HostSpawnOptions = Parameters<TerminalHostOptions['spawnSubprocess']>[0]

describe('spawn env for a daemon from before the decouple', () => {
  it('tells the daemons apart by the handle env their hello names', () => {
    expect(daemonReadsLegacyEnv({ ...IDENTITY, terminalHandleEnv: TERMINAL_HANDLE_ENV })).toBe(
      false
    )
    expect(daemonReadsLegacyEnv(IDENTITY)).toBe(true)
    expect(daemonReadsLegacyEnv(null)).toBe(true)
    expect(daemonReadsLegacyEnv({ ...IDENTITY, terminalHandleEnv: 'OTHER_HANDLE' })).toBe(true)
  })

  it.runIf(ENV_DECOUPLED)('adds the ORCA_ twin of each renamed name, keeping one the env sets', () => {
    expect(
      withLegacyEnvTwins({
        [current('AGENT_TREE')]: '1',
        [current('TERMINAL_HANDLE')]: 'term-1',
        [current('HISTFILE')]: '/h/zsh_history',
        [current('PANE_KEY')]: 'tab-1:pane',
        [legacy('PANE_KEY')]: 'explicit',
        SHELL: '/bin/zsh'
      })
    ).toEqual({
      // Fork-only: POD_ before the decouple too, so no daemon reads an ORCA_ spelling of it.
      [current('AGENT_TREE')]: '1',
      [current('TERMINAL_HANDLE')]: 'term-1',
      [legacy('TERMINAL_HANDLE')]: 'term-1',
      [current('HISTFILE')]: '/h/zsh_history',
      [legacy('HISTFILE')]: '/h/zsh_history',
      [current('PANE_KEY')]: 'tab-1:pane',
      [legacy('PANE_KEY')]: 'explicit',
      SHELL: '/bin/zsh'
    })
    expect(withLegacyEnvTwinsToDelete([current('CODEX_HOME'), 'CODEX_HOME'])).toEqual([
      current('CODEX_HOME'),
      'CODEX_HOME',
      legacy('CODEX_HOME')
    ])
  })

  it("leaves the request alone for a daemon that reads this build's names", () => {
    const opts = { cols: 80, rows: 24, env: { [current('HISTFILE')]: '/h' } }
    expect(
      spawnOptionsForDaemon(opts, { ...IDENTITY, terminalHandleEnv: TERMINAL_HANDLE_ENV })
    ).toBe(opts)
    const bare = { cols: 80, rows: 24 }
    expect(spawnOptionsForDaemon(bare, null)).toBe(bare)
  })
})

describe('a spawn through the adapter', () => {
  let harness: DaemonAdapterHarness | null = null
  let received: { env?: Record<string, string>; envToDelete?: string[] }[] = []

  afterEach(async () => {
    vi.restoreAllMocks()
    harness?.adapter.dispose()
    await harness?.server.shutdown()
    if (harness) {
      rmSync(harness.dir, { recursive: true, force: true })
    }
    harness = null
    received = []
  })

  async function spawnThroughAdapter(
    request: { env: Record<string, string>; envToDelete: string[] } = {
      env: { [current('TERMINAL_HANDLE')]: 'term-1', [current('SHELL_FEATURES')]: 'history' },
      envToDelete: [current('HISTFILE')]
    }
  ): Promise<void> {
    harness = await startDaemonAdapterHarness((opts: HostSpawnOptions) => {
      received.push({ env: opts.env, envToDelete: opts.envToDelete })
      return createMockSubprocess()
    })
    await harness.adapter.spawn({ cols: 80, rows: 24, ...request })
  }

  it("sends POD_ only to a daemon whose hello names this build's handle env", async () => {
    await spawnThroughAdapter()
    expect(received).toEqual([
      {
        env: { [current('TERMINAL_HANDLE')]: 'term-1', [current('SHELL_FEATURES')]: 'history' },
        envToDelete: [current('HISTFILE')]
      }
    ])
  })

  it.runIf(ENV_DECOUPLED)('sends both spellings to a daemon whose hello names no handle env', async () => {
    const real = DaemonClient.prototype.getDaemonIdentity
    vi.spyOn(DaemonClient.prototype, 'getDaemonIdentity').mockImplementation(function (
      this: DaemonClient
    ) {
      const identity = real.call(this)
      return (
        identity && {
          pid: identity.pid,
          startedAtMs: identity.startedAtMs,
          launchNonce: identity.launchNonce
        }
      )
    })
    await spawnThroughAdapter()
    expect(received).toEqual([
      {
        env: {
          [current('TERMINAL_HANDLE')]: 'term-1',
          [current('SHELL_FEATURES')]: 'history',
          [legacy('TERMINAL_HANDLE')]: 'term-1',
          [legacy('SHELL_FEATURES')]: 'history'
        },
        envToDelete: [current('HISTFILE'), legacy('HISTFILE')]
      }
    ])
  })
})
