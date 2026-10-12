import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { launchDaemonChild } from './daemon-launched-child'
import type { DaemonChildSpawnOptions } from './daemon-launched-child-spawn'
import { DAEMON_RECOVERY_BUDGET_MS } from './daemon-recovery-budget'
import {
  DARWIN_COLD_EXEC_READY_MS,
  darwinDaemonStartupTimeoutMs
} from './daemon-startup-budget-darwin'

const { spawnDaemonChildProcessMock } = vi.hoisted(() => ({
  spawnDaemonChildProcessMock: vi.fn()
}))

vi.mock('./daemon-launched-child-spawn', () => ({
  spawnDaemonChildProcess: spawnDaemonChildProcessMock
}))
vi.mock('./daemon-cgroup-scope', () => ({ isDurableDaemonScopeSupported: () => false }))
vi.mock('./daemon-spawner', () => ({ unlinkOwnedDaemonPidFile: vi.fn(() => true) }))

type FakeDaemonChild = EventEmitter & {
  pid: number
  disconnect: Mock
  unref: Mock
  exitCode: number | null
  signalCode: NodeJS.Signals | null
}

const LAUNCH_OPTIONS: DaemonChildSpawnOptions = {
  entryPath: '/fake/app/out/main/daemon-entry.js',
  forkEntryPath: '/fake/clone/out/main/daemon-entry.js',
  userDataPath: '/fake/userData',
  socketPath: '/fake/socket',
  tokenPath: '/fake/token',
  pidPath: '/fake/daemon.pid',
  launchNonce: 'nonce-a',
  macosLoginSessionWatch: false
}

function fakeDaemonChild(pid: number): FakeDaemonChild {
  return Object.assign(new EventEmitter(), {
    pid,
    disconnect: vi.fn(),
    unref: vi.fn(),
    exitCode: null,
    signalCode: null
  })
}

afterEach(() => {
  vi.useRealTimers()
  spawnDaemonChildProcessMock.mockReset()
})

describe('darwinDaemonStartupTimeoutMs', () => {
  const start = 1_000_000

  it('gives a first start whose recovery spent nothing the whole cold-exec allowance', () => {
    const deadline = start + DAEMON_RECOVERY_BUDGET_MS
    // A fresh profile: no endpoint to adopt, the clone took its whole 8 s budget.
    expect(darwinDaemonStartupTimeoutMs(deadline, start + 9_000, 'darwin')).toBe(
      DARWIN_COLD_EXEC_READY_MS
    )
  })

  it('falls back to upstream 10 s when recovery and the stale kill used their whole budget', () => {
    const deadline = start + DAEMON_RECOVERY_BUDGET_MS
    expect(darwinDaemonStartupTimeoutMs(deadline, deadline + 10_500, 'darwin')).toBe(10_000)
    expect(darwinDaemonStartupTimeoutMs(deadline, deadline + 30_000, 'darwin')).toBe(10_000)
  })

  it('gives what is left in between', () => {
    const deadline = start + DAEMON_RECOVERY_BUDGET_MS
    expect(darwinDaemonStartupTimeoutMs(deadline, deadline, 'darwin')).toBe(20_500)
  })

  it('leaves other platforms on their own default', () => {
    expect(darwinDaemonStartupTimeoutMs(start + 32_000, start, 'linux')).toBeUndefined()
    expect(darwinDaemonStartupTimeoutMs(start + 32_000, start, 'win32')).toBeUndefined()
  })
})

describe('a daemon whose first exec is slow', () => {
  // The fork reaches 'ready' 15 s after the spawn, as a fresh clone's first exec did at load ~46.
  const SLOW_FIRST_EXEC_MS = 15_000

  function slowDaemon(): FakeDaemonChild {
    const child = fakeDaemonChild(4242)
    setTimeout(
      () => child.emit('message', { type: 'ready', pid: 4242, startedAtMs: 1_000_000 }),
      SLOW_FIRST_EXEC_MS
    )
    return child
  }

  it('starts within the macOS budget of a fresh first start', async () => {
    vi.useFakeTimers()
    spawnDaemonChildProcessMock.mockImplementation(() => slowDaemon())
    const launch = launchDaemonChild({
      ...LAUNCH_OPTIONS,
      startupTimeoutMs: darwinDaemonStartupTimeoutMs(
        Date.now() + DAEMON_RECOVERY_BUDGET_MS,
        Date.now(),
        'darwin'
      )
    })
    await vi.advanceTimersByTimeAsync(SLOW_FIRST_EXEC_MS)
    await expect(launch).resolves.toMatchObject({ identity: { pid: 4242 } })
  })

  it('timed out at upstream 10 s, which sent the first start to local PTYs', async () => {
    vi.useFakeTimers()
    const child = slowDaemon()
    // The timed-out fork is killed; it exits on the signal.
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      child.signalCode = 'SIGTERM'
      queueMicrotask(() => child.emit('exit', null, 'SIGTERM'))
      return true
    })
    spawnDaemonChildProcessMock.mockReturnValue(child)
    try {
      const launch = launchDaemonChild({ ...LAUNCH_OPTIONS, startupTimeoutMs: 10_000 })
      const outcome = expect(launch).rejects.toThrow('Daemon startup timed out')
      await vi.advanceTimersByTimeAsync(10_000)
      await outcome
    } finally {
      kill.mockRestore()
    }
  })
})
