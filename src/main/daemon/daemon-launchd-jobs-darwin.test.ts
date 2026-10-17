import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult } from '@orca/process-host/process-spec'
import {
  DAEMON_LAUNCHD_STDERR_LOG_NAME,
  createDarwinDaemonLaunchdJobs,
  daemonLaunchdJobsDir,
  daemonLaunchdLabelPrefix,
  parseDaemonLaunchdList,
  sweepDeadDaemonLaunchdJobs
} from './daemon-launchd-jobs-darwin'
import type { DaemonLaunchdJob } from './daemon-launchd-launch'

let dir: string
let userData: string
let logs: string
let jobsDir: string

function result(code: number, stdout = '', stderr = ''): ProcessResult {
  return { code, signal: null, stdout, stderr, timedOut: false }
}

const job: DaemonLaunchdJob = {
  program: '/usr/sbin/taskpolicy',
  args: ['-a', '/clone/Contents/MacOS/Pod', '/clone/daemon-entry.js', '--socket', '/data/d.sock'],
  env: { ELECTRON_RUN_AS_NODE: '1', ODD: 'a<b & "c">', UNSET: undefined },
  cwd: '/data',
  exitTimeoutSeconds: 7,
  numberOfFiles: 10_240
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pod-launchd-jobs-'))
  userData = join(dir, 'userData')
  logs = join(userData, 'logs')
  jobsDir = daemonLaunchdJobsDir(join(userData, 'daemon'))
  mkdirSync(userData)
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('launchd jobs of a profile', () => {
  it('label every launch under one prefix per profile', () => {
    const prefix = daemonLaunchdLabelPrefix(userData)
    expect(prefix).toMatch(/^codes\.pod\.daemon\.[0-9a-f]{12}\.$/)
    expect(daemonLaunchdLabelPrefix(join(dir, 'other'))).not.toBe(prefix)
    const paths = createDarwinDaemonLaunchdJobs(jobsDir, vi.fn(), () => logs).paths({
      userDataPath: userData,
      launchNonce: 'nonce-1'
    })
    expect(paths.label).toBe(`${prefix}nonce-1`)
    // Under userData/daemon, which the cask's zap removes; nothing goes to ~/Library/LaunchAgents.
    expect(paths.plistPath).toBe(join(userData, 'daemon', 'launchd', `${prefix}nonce-1.plist`))
    expect(paths.reportPath).toBe(
      join(userData, 'daemon', 'launchd', `${prefix}nonce-1.report.json`)
    )
    expect(paths.stderrPath).toBe(join(logs, DAEMON_LAUNCHD_STDERR_LOG_NAME))
  })

  it('write a private plist with the job keys and an escaped environment', () => {
    const jobs = createDarwinDaemonLaunchdJobs(jobsDir, vi.fn(), () => logs)
    const paths = jobs.paths({ userDataPath: userData, launchNonce: 'nonce-1' })
    jobs.writePlist(paths, job)
    expect(statSync(paths.plistPath).mode & 0o777).toBe(0o600)
    expect(statSync(jobsDir).mode & 0o777).toBe(0o700)
    const plist = readFileSync(paths.plistPath, 'utf8')
    expect(plist).toContain(`<key>Label</key><string>${paths.label}</string>`)
    expect(plist).toContain('<string>/usr/sbin/taskpolicy</string>\n    <string>-a</string>')
    expect(plist).toContain('<key>ODD</key><string>a&lt;b &amp; &quot;c&quot;&gt;</string>')
    expect(plist).not.toContain('UNSET')
    expect(plist).toContain('<key>AbandonProcessGroup</key><true/>')
    expect(plist).toContain('<key>ProcessType</key><string>Interactive</string>')
    expect(plist).toContain('<key>KeepAlive</key><false/>')
    expect(plist).toContain('<key>ExitTimeOut</key><integer>7</integer>')
    expect(plist).toContain('<key>NumberOfFiles</key><integer>10240</integer>')
    expect(plist).toContain('<key>WorkingDirectory</key><string>/data</string>')
    expect(readFileSync(paths.stderrPath, 'utf8')).toMatch(new RegExp(`^--- .+ ${paths.label}\n$`))
  })

  it('rotate a stderr log past 2 MB before a launch', () => {
    const jobs = createDarwinDaemonLaunchdJobs(jobsDir, vi.fn(), () => logs)
    const paths = jobs.paths({ userDataPath: userData, launchNonce: 'nonce-2' })
    mkdirSync(logs, { recursive: true })
    writeFileSync(paths.stderrPath, 'x'.repeat(2 * 1024 * 1024 + 1))
    jobs.writePlist(paths, job)
    expect(statSync(`${paths.stderrPath}.1`).size).toBe(2 * 1024 * 1024 + 1)
    expect(readFileSync(paths.stderrPath, 'utf8')).toContain(paths.label)
  })

  it('boot a job out, and take an already gone job as done', async () => {
    const launchctl = vi
      .fn()
      .mockResolvedValueOnce(result(0))
      .mockResolvedValueOnce(result(113, '', 'Could not find service'))
      .mockResolvedValueOnce(result(5, '', 'Input/output error'))
    const jobs = createDarwinDaemonLaunchdJobs(jobsDir, launchctl, () => logs)
    await jobs.bootout('codes.pod.daemon.x.1')
    await jobs.bootout('codes.pod.daemon.x.2')
    await expect(jobs.bootout('codes.pod.daemon.x.3')).rejects.toThrow(
      'launchctl bootout exited 5: Input/output error'
    )
    expect(launchctl.mock.calls[0]?.[0]).toEqual([
      'bootout',
      `gui/${process.getuid?.() ?? -1}/codes.pod.daemon.x.1`
    ])
  })
})

describe('launchd job control', () => {
  it('signals a job by label through launchctl kill', async () => {
    const launchctl = vi.fn(async () => result(0))
    const jobs = createDarwinDaemonLaunchdJobs(jobsDir, launchctl, () => logs)
    await jobs.signal('codes.pod.daemon.x.1', 'SIGTERM')
    expect(launchctl.mock.calls[0]?.[0]).toEqual([
      'kill',
      '15',
      `gui/${process.getuid?.() ?? -1}/codes.pod.daemon.x.1`
    ])
  })

  it('gives a symlinked profile the prefix of its real path', () => {
    const link = join(dir, 'link')
    symlinkSync(userData, link)
    expect(daemonLaunchdLabelPrefix(link)).toBe(daemonLaunchdLabelPrefix(userData))
  })
})

describe('the sweep before a launch', () => {
  it('reads only this profile from launchctl list', () => {
    const prefix = daemonLaunchdLabelPrefix(userData)
    const listed = `PID\tStatus\tLabel\n-\t0\t${prefix}dead\n4242\t0\t${prefix}live\n-\t0\tcodes.pod.daemon.000000000000.other\n123\t0\tcom.apple.Finder\n`
    expect(parseDaemonLaunchdList(listed, prefix)).toEqual([
      { label: `${prefix}dead`, pid: null },
      { label: `${prefix}live`, pid: 4242 }
    ])
  })

  it('boots out dead jobs and their files, never a live one or another profile', async () => {
    const prefix = daemonLaunchdLabelPrefix(userData)
    mkdirSync(jobsDir, { recursive: true })
    for (const name of [
      `${prefix}dead.plist`,
      `${prefix}live.report.json`,
      `${prefix}crashed.plist.77.tmp`
    ]) {
      writeFileSync(join(jobsDir, name), '')
      // Older than a start in flight.
      utimesSync(join(jobsDir, name), Date.now() / 1000 - 120, Date.now() / 1000 - 120)
    }
    const launchctl = vi.fn(async () =>
      result(
        0,
        `PID\tStatus\tLabel\n-\t1\t${prefix}dead\n4242\t0\t${prefix}live\n-\t0\tcodes.pod.daemon.000000000000.other\n`
      )
    )
    const bootout = vi.fn(async () => {})
    expect(await sweepDeadDaemonLaunchdJobs(userData, jobsDir, { bootout }, launchctl)).toEqual([
      `${prefix}dead`
    ])
    expect(bootout.mock.calls).toEqual([[`${prefix}dead`]])
    expect(existsSync(join(jobsDir, `${prefix}dead.plist`))).toBe(false)
    expect(existsSync(join(jobsDir, `${prefix}crashed.plist.77.tmp`))).toBe(false)
    expect(existsSync(join(jobsDir, `${prefix}live.report.json`))).toBe(true)
  })

  it("leaves another launcher's start in flight alone", async () => {
    const prefix = daemonLaunchdLabelPrefix(userData)
    mkdirSync(jobsDir, { recursive: true })
    writeFileSync(join(jobsDir, `${prefix}fresh.plist`), '')
    writeFileSync(join(jobsDir, `${prefix}old.report.json`), '')
    const old = Date.now() / 1000 - 120
    utimesSync(join(jobsDir, `${prefix}old.report.json`), old, old)
    const launchctl = vi.fn(async () =>
      result(0, `PID\tStatus\tLabel\n-\t0\t${prefix}fresh\n-\t0\t${prefix}old\n`)
    )
    const bootout = vi.fn(async () => {})
    expect(await sweepDeadDaemonLaunchdJobs(userData, jobsDir, { bootout }, launchctl)).toEqual([
      `${prefix}old`
    ])
  })

  it('does nothing when launchctl list fails', async () => {
    const bootout = vi.fn(async () => {})
    const launchctl = vi.fn(async () => result(1))
    expect(await sweepDeadDaemonLaunchdJobs(userData, jobsDir, { bootout }, launchctl)).toEqual([])
    expect(bootout).not.toHaveBeenCalled()
  })
})
