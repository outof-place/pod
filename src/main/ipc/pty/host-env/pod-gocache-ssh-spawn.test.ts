import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { statSyncMock } from '../../pty-ipc-mock-registry'
import { setupPtyIpcSuite } from '../../pty-ipc-test-harness'
import { createDaemonActiveProviderFixtures } from '../../pty-ipc-daemon-provider-fixtures'
import { registerPtyHandlers, registerSshPtyProvider } from '../../pty'
import type { IPtyProvider } from '../../../providers/pty-provider-contract'
import { setPodGoCacheSettingReader } from '../../../pod/gocache/pod-gocache-pty-env'

vi.mock('electron', () => import('../../pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('../../pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('../../pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('../../pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../../../opencode/hook-service', () =>
  import('../../pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../../../mimo/hook-service', () =>
  import('../../pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../../../agent-hooks/server', () =>
  import('../../pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../../../pi/titlebar-extension-service', () =>
  import('../../pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../../../pwsh', () =>
  import('../../pty-ipc-mock-registry').then((m) => m.pwshModuleMock())
)
vi.mock('../../../wsl', async (importOriginal) =>
  (await import('../../pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('../../../telemetry/client', () =>
  import('../../pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../../../telemetry/classify-error', () =>
  import('../../pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../../../cli/linux-terminal-orca-cli-shim', () =>
  import('../../pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../../../memory/pty-registry', () =>
  import('../../pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../../../agent-hooks/migration-unsupported-pty-state', () =>
  import('../../pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../../../codex/codex-pane-account-registry', () =>
  import('../../pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../../../codex/codex-state-db-backfill-recovery', () =>
  import('../../pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)

// Why at the IPC handler: SSH safety is that the host env assembly never runs for a remote pane,
// so only a real pty:spawn shows a local pane gets GOCACHEPROG (with the dev opt-in) while a
// remote one never does.

describe('GOCACHEPROG through pty:spawn', () => {
  const { handlers, mainWindow } = setupPtyIpcSuite()
  const { daemonSpawnAndGetEnv } = createDaemonActiveProviderFixtures({ handlers, mainWindow })
  const realPlatform = process.platform
  const home = '/Users/pod-gocache-spawn'
  const helper = join(home, '.pod/gocache/bin/pod-gocache')

  beforeEach(() => {
    vi.stubEnv('HOME', home)
    vi.stubEnv('POD_GOCACHE', undefined)
    vi.stubEnv('POD_GOCACHE_TERMINAL_ENV', '1')
    vi.stubEnv('GOCACHEPROG', undefined)
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    setPodGoCacheSettingReader(() => true)
    // this suite's fs is a double: the helper is installed, every other path a directory
    statSyncMock.mockImplementation((path: string) =>
      path === helper
        ? { isFile: () => true, isDirectory: () => false, mode: 0o100755, size: 1 }
        : { isFile: () => false, isDirectory: () => true, mode: 0o40755, size: 1 }
    )
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform })
    vi.unstubAllEnvs()
  })

  it('a local pane on the terminal daemon gets none without the opt-in', async () => {
    vi.stubEnv('POD_GOCACHE_TERMINAL_ENV', undefined)

    expect((await daemonSpawnAndGetEnv()).GOCACHEPROG).toBeUndefined()
  })

  it('a local pane on the terminal daemon gets it with the opt-in', async () => {
    const env = await daemonSpawnAndGetEnv()

    expect(env.GOCACHEPROG).toBe(`${helper} prog`)
  })

  it("leaves the daemon's inherited GOCACHEPROG alone: the user's wins there too", async () => {
    vi.stubEnv('GOCACHEPROG', '/opt/tools/my-cache prog')

    expect((await daemonSpawnAndGetEnv()).GOCACHEPROG).toBeUndefined()
  })

  it('an SSH pane never does, even opted in with the helper installed here', async () => {
    const spawn = vi.fn<IPtyProvider['spawn']>(async () => ({ id: 'ssh-pty' }))
    const provider: IPtyProvider = {
      spawn,
      attach: vi.fn(),
      write: vi.fn(),
      writeWithSettlement: vi.fn(),
      resize: vi.fn(),
      shutdown: vi.fn(),
      sendSignal: vi.fn(),
      getCwd: vi.fn(),
      getInitialCwd: vi.fn(),
      clearBuffer: vi.fn(),
      resetInputModes: vi.fn(),
      acknowledgeDataEvent: vi.fn(),
      hasChildProcesses: vi.fn(),
      getForegroundProcess: vi.fn(),
      serialize: vi.fn(),
      revive: vi.fn(),
      listProcesses: vi.fn(async () => []),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn(),
      onData: vi.fn(() => () => {}),
      onReplay: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {})
    }
    registerSshPtyProvider('ssh-1', provider)
    handlers.clear()
    registerPtyHandlers()

    await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      env: { FOO: 'bar' },
      connectionId: 'ssh-1',
      worktreeId: 'wt-1'
    })

    const env = spawn.mock.calls.at(-1)![0].env ?? {}
    expect(env.FOO).toBe('bar')
    expect(env.GOCACHEPROG).toBeUndefined()
  })
})
