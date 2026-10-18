// Fork-only (Pod): an agent-session spawn (runtime/spawn-execute.ts) sends user POD_ settings as
// ORCA_ too, but no alias (pod-env-aliases.ts, mode 'request'), as spawnForStablePane does.
import { describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import type { AgentSessionOwnerBinding } from '../../shared/agent-session-host-authority'
import type { IPtyProvider, PtyProcessInfo } from '../providers/types'
import { POD_USER_SETTABLE_ORCA_ENV_NAMES, podSpellingOf } from '../../shared/pod-env-aliases'
import { podEnvAliasProviderDouble } from '../pod/decouple/pod-env-aliases.test-support'
import { clearProviderPtyState, setLocalPtyProvider } from './pty'

vi.mock('electron', () => import('./pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('./pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../opencode/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../mimo/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../agent-hooks/server', () =>
  import('./pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../pi/titlebar-extension-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../pwsh', () => import('./pty-ipc-mock-registry').then((m) => m.pwshModuleMock()))
vi.mock('../wsl', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('../telemetry/client', () =>
  import('./pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../telemetry/classify-error', () =>
  import('./pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../cli/linux-terminal-orca-cli-shim', () =>
  import('./pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../memory/pty-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../agent-hooks/migration-unsupported-pty-state', () =>
  import('./pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../codex/codex-pane-account-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../codex/codex-state-db-backfill-recovery', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)

describe('agent-session spawn POD_ env', () => {
  const { recoveredAgentClaim, recoveredAgentSurface, registerAgentClaimController } =
    setupPtyIpcSuite()

  it('normalizes a user POD_ setting, mirrors deletions, and adds no alias', async () => {
    const claim = {
      ...recoveredAgentClaim,
      identityDigest: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
    }
    const sessions: PtyProcessInfo[] = []
    const spawn = vi.fn<IPtyProvider['spawn']>(async (options) => {
      if (!options.agentSessionEnsure) {
        throw new Error('missing test claim')
      }
      const owner: AgentSessionOwnerBinding = {
        claim: options.agentSessionEnsure.claim,
        generation: 'generation-pod-env',
        phase: 'live',
        ptyId: 'pty-pod-env',
        surface: options.agentSessionEnsure.surface
      }
      sessions.push({
        id: owner.ptyId,
        cwd: '/tmp/recovered-worktree',
        title: 'Codex',
        agentSessionOwners: [owner]
      })
      return { id: owner.ptyId, agentSessionEnsure: { disposition: 'created', owner } }
    })
    setLocalPtyProvider(
      podEnvAliasProviderDouble(spawn, {
        listProcesses: vi.fn(async () => sessions),
        providesAgentSessionOwnerListings: vi.fn(() => true),
        hasPty: vi.fn(() => false)
      })
    )
    const controller = registerAgentClaimController()

    await expect(
      controller.spawn({
        cols: 80,
        rows: 24,
        cwd: '/tmp/recovered-worktree',
        env: { ORCA_GITEA_TOKEN: 'orca', POD_GITEA_TOKEN: 'pod', POD_TELEMETRY_DISABLED: '1' },
        envToDelete: ['ORCA_TELEMETRY_DISABLED'],
        agentSessionEnsure: { claim, surface: recoveredAgentSurface }
      })
    ).resolves.toMatchObject({ id: 'pty-pod-env' })

    expect(spawn).toHaveBeenCalledOnce()
    const sent = spawn.mock.calls[0][0]
    expect(sent.env?.ORCA_GITEA_TOKEN).toBe('pod')
    expect(sent.envToDelete).toContain('POD_TELEMETRY_DISABLED')
    const userSettable = new Set(POD_USER_SETTABLE_ORCA_ENV_NAMES)
    const appNames = Object.keys(sent.env ?? {}).filter(
      (name) => name.startsWith('ORCA_') && !userSettable.has(name)
    )
    expect(appNames.length).toBeGreaterThan(0)
    expect(appNames.filter((name) => sent.env?.[podSpellingOf(name)] !== undefined)).toEqual([])
    clearProviderPtyState('pty-pod-env')
  })
})
