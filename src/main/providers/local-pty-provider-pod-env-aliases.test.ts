import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as MacosTccLoginShell from './macos-tcc-login-shell'
import { POD_USER_SETTABLE_ORCA_ENV_NAMES } from '../../shared/pod-env-aliases'
import {
  expectPodEnvAliasesConsistent,
  podUserSettingMarkers
} from '../pod/decouple/pod-env-aliases.test-support'

// Fork-only (Pod): the local spawn's final env carries the POD_ aliases (pod-env-aliases.ts).

const {
  existsSyncMock,
  statSyncMock,
  accessSyncMock,
  mkdirSyncMock,
  writeFileSyncMock,
  spawnMock,
  prepareMacosTccLoginShellMock,
  resolveAgentForegroundProcessMock,
  readWindowsPtyJobProcessIdsMock,
  killWithDescendantSweepMock,
  isWslAvailableAsyncMock,
  wslUncDirectoryExistsMock,
  createShellPromptReadinessProbeMock
} = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  statSyncMock: vi.fn(),
  accessSyncMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  spawnMock: vi.fn(),
  prepareMacosTccLoginShellMock: vi.fn(),
  resolveAgentForegroundProcessMock: vi.fn(),
  readWindowsPtyJobProcessIdsMock: vi.fn(),
  killWithDescendantSweepMock: vi.fn(),
  isWslAvailableAsyncMock: vi.fn(),
  wslUncDirectoryExistsMock: vi.fn(),
  createShellPromptReadinessProbeMock: vi.fn()
}))

vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  statSync: statSyncMock,
  accessSync: accessSyncMock,
  mkdirSync: mkdirSyncMock,
  writeFileSync: writeFileSyncMock,
  chmodSync: vi.fn(),
  renameSync: vi.fn(),
  rmSync: vi.fn(),
  constants: { X_OK: 1 }
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/orca-user-data')
  }
}))

vi.mock('node-pty', () => ({
  spawn: spawnMock
}))

vi.mock('./macos-tcc-login-shell', async (importOriginal) => ({
  ...(await importOriginal<typeof MacosTccLoginShell>()),
  prepareMacosTccLoginShell: prepareMacosTccLoginShellMock
}))

vi.mock('../pty-descendant-termination', () => ({
  killWithDescendantSweep: killWithDescendantSweepMock
}))

// Resolve PowerShell family names to deterministic absolute paths (the fs mock
// above otherwise makes every probe miss). The real resolver — which skips the
// Store App Execution Alias stub — is covered in
// windows-powershell-executable.test.ts.
const WINDOWS_POWERSHELL_ABS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const PWSH7_ABS = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
const CMD_ABS = 'C:\\Windows\\System32\\cmd.exe'
vi.mock('./windows-powershell-executable', () => ({
  resolveWindowsPowerShellExecutablePath: (family: 'pwsh.exe' | 'powershell.exe') =>
    family === 'pwsh.exe' ? PWSH7_ABS : WINDOWS_POWERSHELL_ABS,
  resolveWindowsPowerShellSpawnChain: (family: 'pwsh.exe' | 'powershell.exe') =>
    family === 'pwsh.exe'
      ? [PWSH7_ABS, WINDOWS_POWERSHELL_ABS, CMD_ABS]
      : [WINDOWS_POWERSHELL_ABS, CMD_ABS],
  getWindowsCmdPath: () => CMD_ABS
}))

vi.mock('./agent-foreground-process', () => ({
  resolveAgentForegroundProcessWithAvailability: (...args: unknown[]) =>
    resolveAgentForegroundProcessMock(...args)
}))

vi.mock('./windows-pty-job-membership', () => ({
  readWindowsPtyJobProcessIds: (...args: unknown[]) => readWindowsPtyJobProcessIdsMock(...args),
  isWindowsPtyJobReadable: () => true
}))

vi.mock('../wsl', () => ({
  parseWslPath: (path: string) => {
    const match = path.match(/^\\\\wsl\.localhost\\([^\\]+)(.*)$/)
    if (!match) {
      return null
    }
    return {
      distro: match[1],
      linuxPath: (match[2] || '').replace(/\\/g, '/') || '/'
    }
  },
  toLinuxPath: (path: string) => path.replace(/^C:\\/i, '/mnt/c/').replace(/\\/g, '/'),
  toWindowsWslPath: (path: string, distro: string) =>
    `\\\\wsl.localhost\\${distro}${path.replace(/\//g, '\\')}`,
  getDefaultWslDistro: () => 'Ubuntu',
  isWslAvailableAsync: () => isWslAvailableAsyncMock(),
  // Why: WSL worktree validation now asks the distro; these tests use WSL UNC
  // cwds that are meant to exist, so report them present without spawning wsl.exe.
  wslUncDirectoryExists: (...args: unknown[]) => wslUncDirectoryExistsMock(...args)
}))

vi.mock('../shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: createShellPromptReadinessProbeMock
}))

import { LocalPtyProvider } from './local-pty-provider'
import {
  applyLocalPtyProviderMockDefaults,
  createLocalPtyMockProcess,
  installLocalPtyProviderEnvSandbox,
  type LocalPtyMockProcess
} from './local-pty-provider-test-harness'

describe('LocalPtyProvider POD_ env aliases', () => {
  let provider: LocalPtyProvider
  let mockProc: LocalPtyMockProcess
  let exitCb: ((info: { exitCode: number }) => void) | undefined

  installLocalPtyProviderEnvSandbox()

  beforeEach(() => {
    applyLocalPtyProviderMockDefaults({
      existsSyncMock,
      statSyncMock,
      accessSyncMock,
      mkdirSyncMock,
      writeFileSyncMock,
      prepareMacosTccLoginShellMock,
      resolveAgentForegroundProcessMock,
      readWindowsPtyJobProcessIdsMock,
      killWithDescendantSweepMock,
      isWslAvailableAsyncMock,
      wslUncDirectoryExistsMock,
      createShellPromptReadinessProbeMock
    })

    exitCb = undefined
    mockProc = createLocalPtyMockProcess({
      get: () => exitCb,
      set: (cb) => {
        exitCb = cb
      }
    })
    spawnMock.mockReturnValue(mockProc)

    provider = new LocalPtyProvider()
  })

  afterEach(() => {
    delete process.env.POD_PANE_KEY
  })

  function spawnedEnv(): Record<string, string> {
    return spawnMock.mock.calls.at(-1)?.[2].env
  }

  it('gives every aliased ORCA_ name its POD_ spelling', async () => {
    await provider.spawn({
      cols: 80,
      rows: 24,
      env: { ORCA_PANE_KEY: 'tab-1:pane-1', ORCA_TAB_ID: 'tab-1', ORCA_WORKTREE_ID: 'wt-1' }
    })
    const env = spawnedEnv()
    expect(env.POD_PANE_KEY).toBe('tab-1:pane-1')
    expect(env.POD_TAB_ID).toBe('tab-1')
    expectPodEnvAliasesConsistent(env)
  })

  it('drops a POD_ twin inherited from the app without its ORCA_ name', async () => {
    process.env.POD_PANE_KEY = 'parent-pane'
    await provider.spawn({ cols: 80, rows: 24, env: {} })
    const env = spawnedEnv()
    expect(env).not.toHaveProperty('POD_PANE_KEY')
    expectPodEnvAliasesConsistent(env)
  })

  it("lets a terminal's POD_ setting win, under both names", async () => {
    await provider.spawn({
      cols: 80,
      rows: 24,
      env: { ORCA_GITEA_TOKEN: 'orca-value', POD_GITEA_TOKEN: 'pod-value' }
    })
    const env = spawnedEnv()
    expect(env.ORCA_GITEA_TOKEN).toBe('pod-value')
    expect(env.POD_GITEA_TOKEN).toBe('pod-value')
  })

  it('leaves every user setting as given, under both names', async () => {
    const markers = podUserSettingMarkers(POD_USER_SETTABLE_ORCA_ENV_NAMES)
    await provider.spawn({ cols: 80, rows: 24, env: { ...markers } })
    const env = spawnedEnv()
    for (const [name, value] of Object.entries(markers)) {
      expect(env[name], name).toBe(value)
    }
  })

  it('removes both spellings of a name the spawn deletes', async () => {
    await provider.spawn({
      cols: 80,
      rows: 24,
      env: { ORCA_TAB_ID: 'tab-1', POD_TAB_ID: 'tab-1' },
      envToDelete: ['ORCA_TAB_ID']
    })
    const env = spawnedEnv()
    expect(env).not.toHaveProperty('ORCA_TAB_ID')
    expect(env).not.toHaveProperty('POD_TAB_ID')
    expectPodEnvAliasesConsistent(env)
  })
})
