import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult } from '@orca/process-host/process-spec'
import {
  LaunchdDaemonProcess,
  launchDaemonViaLaunchd,
  type DaemonLaunchdJob,
  type DaemonLaunchdJobs,
  type DaemonLaunchdPaths
} from './daemon-launchd-launch'
import { writeDaemonLaunchdReport, type DaemonLaunchdReport } from './daemon-launchd-report'

vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getVersion: () => '1.0.0' })
}))
vi.mock('./daemon-launch-paths', () => ({ daemonLogArgs: () => [] }))

// No such process: pids on macOS stay below 100000.
const GONE_PID = 99_999_999

let dir: string
let paths: DaemonLaunchdPaths
let written: DaemonLaunchdJob[]
let bootouts: string[]
let jobs: DaemonLaunchdJobs

const options = {
  entryPath: '/app/daemon-entry.js',
  forkEntryPath: '/clone/daemon-entry.js',
  relocatedExecPath: '/clone/Contents/MacOS/Pod',
  userDataPath: '/data',
  socketPath: '/data/daemon.sock',
  tokenPath: '/data/token',
  pidPath: '/data/daemon.pid',
  launchNonce: 'nonce-1',
  macosLoginSessionWatch: false,
  startupTimeoutMs: 1_000
}

function result(code: number, stderr = ''): ProcessResult {
  return { code, signal: null, stdout: '', stderr, timedOut: false }
}

/** launchctl that "starts" the daemon: the reports it would write, `after` ms apart. */
function launchctlReporting(reports: DaemonLaunchdReport[], after = 20) {
  return vi.fn(async (args: string[]) => {
    expect(args.slice(0, 1)).toEqual(['bootstrap'])
    expect(existsSync(paths.plistPath)).toBe(true)
    reports.forEach((report, index) =>
      setTimeout(() => writeDaemonLaunchdReport(paths.reportPath, report), after * (index + 1))
    )
    return result(0)
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pod-launchd-'))
  paths = {
    label: 'codes.pod.daemon.test',
    plistPath: join(dir, 'job.plist'),
    reportPath: join(dir, 'job.report.json'),
    stdoutPath: join(dir, 'job.out'),
    stderrPath: join(dir, 'job.err')
  }
  written = []
  bootouts = []
  jobs = {
    paths: () => paths,
    writePlist: (_paths, job) => {
      written.push(job)
      writeFileSync(paths.plistPath, 'plist')
    },
    bootout: async (label) => {
      bootouts.push(label)
    }
  }
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('a daemon launchd starts', () => {
  it('runs the clone as plain Node with the report argument, and hands over a ready daemon', async () => {
    const launchctl = launchctlReporting([
      { type: 'started', pid: process.pid },
      { type: 'ready', pid: process.pid, startedAtMs: 1234 }
    ])
    const outcome = await launchDaemonViaLaunchd(options, jobs, launchctl)
    expect(outcome.kind).toBe('ready')
    if (outcome.kind !== 'ready') {
      return
    }
    expect(outcome.identity).toEqual({ pid: process.pid, startedAtMs: 1234 })
    expect(outcome.child.pid).toBe(process.pid)
    expect(outcome.child.label).toBe(paths.label)
    const job = written[0]
    expect(job.program).toBe('/clone/Contents/MacOS/Pod')
    expect(job.args.slice(0, 3)).toEqual([
      '/clone/daemon-entry.js',
      '--socket',
      '/data/daemon.sock'
    ])
    expect(job.args.slice(-2)).toEqual(['--launchd-report', paths.reportPath])
    expect(job.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(job.cwd).toBe('/data')
    expect(launchctl.mock.calls[0]?.[0]).toEqual([
      'bootstrap',
      `gui/${process.getuid?.()}`,
      paths.plistPath
    ])
    // The plist holds the environment; launchd keeps its own copy.
    expect(existsSync(paths.plistPath)).toBe(false)
    expect(existsSync(paths.reportPath)).toBe(false)
    expect(bootouts).toEqual([])
  })

  it('reports a lost endpoint race, with the job booted out', async () => {
    const launchctl = launchctlReporting([
      { type: 'started', pid: process.pid },
      { type: 'endpoint-unavailable', reason: 'occupied' }
    ])
    expect(await launchDaemonViaLaunchd(options, jobs, launchctl)).toEqual({
      kind: 'endpoint-unavailable',
      reason: 'occupied'
    })
    expect(bootouts).toEqual([paths.label])
  })

  it('throws when launchctl refuses the job, so the caller forks', async () => {
    const launchctl = vi.fn(async () => result(5, 'Input/output error'))
    await expect(launchDaemonViaLaunchd(options, jobs, launchctl)).rejects.toThrow(
      'launchctl bootstrap exited 5: Input/output error'
    )
    expect(bootouts).toEqual([paths.label])
    expect(existsSync(paths.plistPath)).toBe(false)
  })

  it('fails fast when the started daemon dies, with its stderr', async () => {
    const launchctl = launchctlReporting([{ type: 'started', pid: GONE_PID }])
    writeFileSync(paths.stderrPath, 'Error: cannot find module\n')
    const started = Date.now()
    await expect(launchDaemonViaLaunchd(options, jobs, launchctl)).rejects.toThrow(
      /Daemon exited during startup\nDaemon stderr \(tail\):\nError: cannot find module/
    )
    expect(Date.now() - started).toBeLessThan(options.startupTimeoutMs)
    expect(bootouts).toEqual([paths.label])
  })

  it('times out on a daemon that never reports', async () => {
    const launchctl = launchctlReporting([])
    await expect(
      launchDaemonViaLaunchd({ ...options, startupTimeoutMs: 100 }, jobs, launchctl)
    ).rejects.toThrow('Daemon startup timed out')
    expect(bootouts).toEqual([paths.label])
  })
})

describe('the handle of a launchd daemon', () => {
  it('runs while its pid lives', () => {
    const child = new LaunchdDaemonProcess(process.pid, 'label', async () => {})
    expect(child.exitCode).toBeNull()
    expect(child.connected).toBe(false)
  })

  it('sees the exit, says so once, and boots the job out', async () => {
    const bootout = vi.fn(async () => {})
    const child = new LaunchdDaemonProcess(GONE_PID, 'label', bootout)
    const exited = new Promise((resolve) => child.once('exit', resolve))
    await exited
    expect(child.exitCode).toBe(-1)
    expect(bootout).toHaveBeenCalledTimes(1)
    expect(bootout).toHaveBeenCalledWith('label')
  })
})
