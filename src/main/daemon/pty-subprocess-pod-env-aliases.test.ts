// Fork-only (Pod): the daemon spawn's final env carries the POD_ aliases (pod-env-aliases.ts).
import { describe, expect, it, vi } from 'vitest'
import type * as LocalPtyUtils from '../providers/local-pty-utils'
import {
  POD_ALIASED_ORCA_ENV_NAMES,
  POD_USER_SETTABLE_ORCA_ENV_NAMES,
  applyPodEnvAliases,
  podSpellingOf
} from '../../shared/pod-env-aliases'
import {
  expectPodEnvAliasesConsistent,
  podUserSettingMarkers
} from '../pod/decouple/pod-env-aliases.test-support'

const {
  spawnMock,
  isPwshAvailableMock,
  validateWorkingDirectoryMock,
  resolveUnixShellPathMock,
  resolveAgentForegroundProcessMock
} = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  isPwshAvailableMock: vi.fn(),
  resolveUnixShellPathMock: vi.fn((shellPath: string) => shellPath),
  resolveAgentForegroundProcessMock: vi.fn(),
  validateWorkingDirectoryMock: vi.fn((cwd: string) => {
    if (cwd.includes('definitely-missing')) {
      throw new Error(
        `Working directory "${cwd}" does not exist. It may have been deleted or is on an unmounted volume.`
      )
    }
  })
}))

vi.mock('node-pty', () => ({
  spawn: spawnMock
}))

vi.mock('../pwsh', () => ({
  isPwshAvailable: isPwshAvailableMock
}))

// Resolve PowerShell family names to deterministic absolute paths so these
// tests run on non-Windows CI. The real resolver (which skips the Store App
// Execution Alias stub) is exercised in windows-powershell-executable.test.ts.
const PWSH7_ABS = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
const WINDOWS_POWERSHELL_ABS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const CMD_ABS = 'C:\\Windows\\System32\\cmd.exe'
vi.mock('../providers/windows-powershell-executable', () => ({
  resolveWindowsPowerShellExecutablePath: (family: 'pwsh.exe' | 'powershell.exe') =>
    family === 'pwsh.exe' ? PWSH7_ABS : WINDOWS_POWERSHELL_ABS,
  resolveWindowsPowerShellSpawnChain: (family: 'pwsh.exe' | 'powershell.exe') =>
    family === 'pwsh.exe'
      ? [PWSH7_ABS, WINDOWS_POWERSHELL_ABS, CMD_ABS]
      : [WINDOWS_POWERSHELL_ABS, CMD_ABS],
  getWindowsCmdPath: () => CMD_ABS
}))

vi.mock('../providers/local-pty-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof LocalPtyUtils>()
  return {
    ...actual,
    resolveUnixShellPath: resolveUnixShellPathMock,
    validateWorkingDirectory: validateWorkingDirectoryMock,
    validateWorkingDirectoryAsync: validateWorkingDirectoryMock
  }
})

vi.mock('../providers/agent-foreground-process', () => ({
  resolveAgentForegroundProcessWithAvailability: async (...args: unknown[]) => {
    const value = await resolveAgentForegroundProcessMock(...args)
    return value && typeof value === 'object' && 'available' in value
      ? value
      : { available: true, processName: value }
  }
}))

// Console-membership reads run a real node-pty fork that never settles under
// fake timers; default to "shell-only" so the degraded-scan guard falls through
// to its existing retirement logic (the degraded-scan behavior itself is
// covered in pty-subprocess-foreground-degraded-scan.test.ts).
vi.mock('../providers/windows-pty-job-membership', () => ({
  readWindowsPtyJobProcessIds: () => new Set([12345]),
  isWindowsPtyJobReadable: () => true
}))

import { createPtySubprocess } from './pty-subprocess'
import { createDaemonPtyEnvironment } from './pty-subprocess/spawn-environment'
import { createPtyShellLaunchPlan } from './pty-subprocess/shell-launch-plan'
import { mockPtyProcess, useDaemonPtySubprocessEnv } from './pty-subprocess-test-harness'

function withPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
  const saved = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: platform })
  return run().finally(() => {
    if (saved) {
      Object.defineProperty(process, 'platform', saved)
    }
  })
}

describe('createPtySubprocess POD_ env aliases', () => {
  useDaemonPtySubprocessEnv({
    spawnMock,
    isPwshAvailableMock,
    resolveUnixShellPathMock,
    resolveAgentForegroundProcessMock,
    validateWorkingDirectoryMock
  })

  function spawnedEnv(): Record<string, string> {
    return spawnMock.mock.calls.at(-1)?.[2].env
  }

  it('gives every aliased ORCA_ name its POD_ spelling', async () => {
    spawnMock.mockReturnValue(mockPtyProcess())
    await createPtySubprocess({
      sessionId: 'test',
      cols: 80,
      rows: 24,
      env: { ORCA_PANE_KEY: 'tab-1:pane-1', ORCA_TAB_ID: 'tab-1' }
    })
    const env = spawnedEnv()
    expect(env.POD_PANE_KEY).toBe('tab-1:pane-1')
    expect(env.POD_TAB_ID).toBe('tab-1')
    expectPodEnvAliasesConsistent(env)
  })

  it('aliases the hook node after finalize sets it again (win32), and drops it elsewhere', async () => {
    spawnMock.mockReturnValue(mockPtyProcess())
    const request = { ORCA_AGENT_HOOK_NODE: '/stale/node', POD_AGENT_HOOK_NODE: '/stale/node' }
    await withPlatform('win32', () =>
      createPtySubprocess({
        sessionId: 'win',
        cols: 80,
        rows: 24,
        cwd: 'C:\\repo',
        env: { ...request }
      })
    )
    expect(spawnedEnv().ORCA_AGENT_HOOK_NODE).toBe(process.execPath)
    expect(spawnedEnv().POD_AGENT_HOOK_NODE).toBe(process.execPath)
    await createPtySubprocess({ sessionId: 'posix', cols: 80, rows: 24, env: { ...request } })
    expect(spawnedEnv()).not.toHaveProperty('ORCA_AGENT_HOOK_NODE')
    expect(spawnedEnv()).not.toHaveProperty('POD_AGENT_HOOK_NODE')
  })

  it('drops both spellings of names finalize strips', async () => {
    spawnMock.mockReturnValue(mockPtyProcess())
    await createPtySubprocess({
      sessionId: 'test',
      cols: 80,
      rows: 24,
      env: { ORCA_PI_STATUS_OWNED: '1', POD_PI_STATUS_OWNED: '1' }
    })
    expect(spawnedEnv()).not.toHaveProperty('ORCA_PI_STATUS_OWNED')
    expect(spawnedEnv()).not.toHaveProperty('POD_PI_STATUS_OWNED')
    expectPodEnvAliasesConsistent(spawnedEnv())
  })

  it("drops a POD_ twin inherited from the daemon's own env", async () => {
    spawnMock.mockReturnValue(mockPtyProcess())
    process.env.POD_PANE_KEY = 'parent-pane'
    try {
      await createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24 })
    } finally {
      delete process.env.POD_PANE_KEY
    }
    expect(spawnedEnv()).not.toHaveProperty('POD_PANE_KEY')
    expectPodEnvAliasesConsistent(spawnedEnv())
  })

  it('leaves every user setting as given, and lets a POD_ setting win', async () => {
    spawnMock.mockReturnValue(mockPtyProcess())
    const markers = podUserSettingMarkers(POD_USER_SETTABLE_ORCA_ENV_NAMES)
    await createPtySubprocess({ sessionId: 'test', cols: 80, rows: 24, env: { ...markers } })
    for (const [name, value] of Object.entries(markers)) {
      expect(spawnedEnv()[name], name).toBe(value)
    }
    await createPtySubprocess({
      sessionId: 'test-2',
      cols: 80,
      rows: 24,
      env: { ORCA_GITEA_TOKEN: 'orca-value', POD_GITEA_TOKEN: 'pod-value' }
    })
    expect(spawnedEnv().ORCA_GITEA_TOKEN).toBe('pod-value')
    expect(spawnedEnv().POD_GITEA_TOKEN).toBe('pod-value')
  })

  it('serves a daemon from before the aliases no alias and no split value', () => {
    // Why direct: an old daemon runs this env path without the final alias pass.
    const env: Record<string, string> = {
      ORCA_PANE_KEY: 'tab-1:pane-1',
      ...podUserSettingMarkers(POD_USER_SETTABLE_ORCA_ENV_NAMES),
      POD_GITEA_TOKEN: 'pod-value'
    }
    applyPodEnvAliases(env, { mode: 'request' })
    const opts = { sessionId: 'old-daemon', cols: 80, rows: 24, env }
    const spawnEnv = createDaemonPtyEnvironment(opts)
    createPtyShellLaunchPlan(opts, spawnEnv)
    const userSettable = new Set(POD_USER_SETTABLE_ORCA_ENV_NAMES)
    for (const name of POD_ALIASED_ORCA_ENV_NAMES) {
      if (userSettable.has(name)) {
        expect(spawnEnv[podSpellingOf(name)], name).toBe(spawnEnv[name])
      } else {
        expect(spawnEnv, name).not.toHaveProperty(podSpellingOf(name))
      }
    }
    expect(spawnEnv.ORCA_GITEA_TOKEN).toBe('pod-value')
  })
})
