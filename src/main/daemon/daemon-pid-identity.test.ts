import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Fs from 'node:fs'
import type * as IdentityQuery from './daemon-process-identity-query'

const { psIdentity } = vi.hoisted(() => ({
  psIdentity: vi.fn<(pid: number) => Promise<{ commandLine: string; startedAtMs: number } | null>>()
}))

vi.mock('./daemon-process-identity-query', async (importOriginal) => ({
  ...(await importOriginal<typeof IdentityQuery>()),
  getPsProcessIdentityAsync: psIdentity
}))

// Why: the darwin path (ps lstart) is the one under test, also on Linux CI where /proc exists.
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof Fs>()
  return {
    ...fs,
    readFileSync: ((path: unknown, ...rest: unknown[]) => {
      if (typeof path === 'string' && path.startsWith('/proc/')) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      return (fs.readFileSync as (...args: unknown[]) => unknown)(path, ...rest)
    }) as typeof fs.readFileSync
  }
})

const { inspectDaemonProcessIdentity } = await import('./daemon-pid-identity')
const { killStaleDaemon } = await import('./daemon-stale-kill')
const { getDaemonPidPath, serializeDaemonPidFile } = await import('./daemon-spawner')

const PID = 424_242
const REPORTED = 1_791_883_530_108
const SOCKET = '/runtime/daemon-v45.sock'
const TOKEN = '/runtime/daemon-v45.token'
const COMMAND = `Pod Helper daemon-entry.js --socket ${SOCKET} --token ${TOKEN}`

describe.skipIf(process.platform === 'win32')('inspectDaemonProcessIdentity start window', () => {
  let killSpy: { mockRestore(): void }

  beforeEach(() => {
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
  })

  afterEach(() => {
    killSpy.mockRestore()
    psIdentity.mockReset()
  })

  it.each([
    ['3.5 s earlier (the live daemon 1047)', -3_500, 'match'],
    ['29 s earlier', -29_000, 'match'],
    ['31 s earlier', -31_000, 'mismatch'],
    ['1.4 s later', 1_400, 'match'],
    ['2 s later (a reused pid)', 2_000, 'mismatch']
  ])('an OS start %s than the pid file says: %s', async (_label, offsetMs, expected) => {
    psIdentity.mockResolvedValue({ commandLine: COMMAND, startedAtMs: REPORTED + offsetMs })
    await expect(inspectDaemonProcessIdentity(PID, SOCKET, TOKEN, REPORTED)).resolves.toBe(expected)
  })

  it('fails open without a recorded start', async () => {
    psIdentity.mockResolvedValue({ commandLine: COMMAND, startedAtMs: REPORTED - 60_000 })
    await expect(inspectDaemonProcessIdentity(PID, SOCKET, TOKEN, null)).resolves.toBe('match')
  })
})

describe.skipIf(process.platform === 'win32')('killStaleDaemon with a lagging pid file', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-start-window-'))
    writeFileSync(
      getDaemonPidPath(dir),
      serializeDaemonPidFile({ pid: PID, startedAtMs: REPORTED }),
      { mode: 0o600 }
    )
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    psIdentity.mockReset()
    vi.restoreAllMocks()
  })

  it('stops the live daemon whose OS start is 3.5 s before its pid file', async () => {
    psIdentity.mockResolvedValue({ commandLine: COMMAND, startedAtMs: REPORTED - 3_500 })
    let alive = true
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 'SIGTERM') {
        alive = false
      } else if (signal === 0 && !alive) {
        throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
      }
      return true
    })
    await expect(killStaleDaemon(dir, SOCKET, TOKEN)).resolves.toMatchObject({ killed: true })
    expect(killSpy.mock.calls.some(([, signal]) => signal === 'SIGTERM')).toBe(true)
  })

  it('skips the SIGKILL when the pid was reused (1 h later) during the SIGTERM wait', async () => {
    psIdentity
      .mockResolvedValueOnce({ commandLine: COMMAND, startedAtMs: REPORTED - 3_500 })
      .mockResolvedValue({ commandLine: COMMAND, startedAtMs: REPORTED + 3_600_000 })
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    await killStaleDaemon(dir, SOCKET, TOKEN)
    expect(killSpy.mock.calls.some(([, signal]) => signal === 'SIGTERM')).toBe(true)
    expect(killSpy.mock.calls.some(([, signal]) => signal === 'SIGKILL')).toBe(false)
  }, 10_000)
})
