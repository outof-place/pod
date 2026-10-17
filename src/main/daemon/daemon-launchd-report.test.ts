import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bootoutOwnLaunchdJobAtExit,
  dropLaunchdJobEnv,
  keepParentCheckedEnv,
  reportLaunchdReady,
  readDaemonLaunchdReport,
  reportToLaunchd,
  takeLaunchdReportPath
} from './daemon-launchd-report'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pod-launchd-report-'))
})
afterEach(() => {
  takeLaunchdReportPath([])
  rmSync(dir, { recursive: true, force: true })
})

describe('the launchd report of a daemon', () => {
  it('is written only when launchd started the daemon', () => {
    const path = join(dir, 'report.json')
    takeLaunchdReportPath(['--socket', '/tmp/s', '--token', '/tmp/t'])
    reportToLaunchd({ type: 'started', pid: 7 })
    expect(readDaemonLaunchdReport(path)).toBeNull()
    takeLaunchdReportPath(['--socket', '/tmp/s', '--launchd-report', path, '--token', '/tmp/t'])
    reportToLaunchd({ type: 'started', pid: 7 })
    reportToLaunchd({ type: 'ready', pid: 7, startedAtMs: 1 })
    expect(readDaemonLaunchdReport(path)).toEqual({ type: 'ready', pid: 7, startedAtMs: 1 })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    // Whole records only: no temporary file is left beside it.
    expect(readdirSync(dir)).toEqual(['report.json'])
  })

  it("drops launchd's job variables, which every PTY would inherit, only when launchd started it", () => {
    const env = { XPC_SERVICE_NAME: 'codes.pod.daemon.x', XPC_FLAGS: '0x0', PATH: '/bin' }
    takeLaunchdReportPath(['--socket', '/tmp/s'])
    expect(dropLaunchdJobEnv(env)).toBeUndefined()
    expect(env.XPC_SERVICE_NAME).toBe('codes.pod.daemon.x')
    takeLaunchdReportPath(['--launchd-report', join(dir, 'report.json')])
    expect(dropLaunchdJobEnv(env)).toBe('codes.pod.daemon.x')
    expect(env).toEqual({ PATH: '/bin' })
  })

  it('gives the PTYs back the node variables Electron drops under a parent that is not the app', () => {
    const job = keepParentCheckedEnv({
      NODE_OPTIONS: '--max-old-space-size=4096',
      NODE_EXTRA_CA_CERTS: '/etc/ca.pem',
      PATH: '/bin'
    })
    expect(job.POD_LAUNCHD_KEPT_NODE_OPTIONS).toBe('--max-old-space-size=4096')
    expect(job.POD_LAUNCHD_KEPT_NODE_EXTRA_CA_CERTS).toBe('/etc/ca.pem')
    expect(job).not.toHaveProperty('POD_LAUNCHD_KEPT_NODE_REPL_EXTERNAL_MODULE')
    // What the daemon finds at start: Electron dropped the originals, launchd added its own.
    const env: NodeJS.ProcessEnv = { ...job, XPC_SERVICE_NAME: 'codes.pod.daemon.x' }
    delete env.NODE_OPTIONS
    delete env.NODE_EXTRA_CA_CERTS
    takeLaunchdReportPath(['--socket', '/tmp/s'])
    dropLaunchdJobEnv(env)
    expect(env.NODE_OPTIONS).toBeUndefined()
    takeLaunchdReportPath(['--launchd-report', join(dir, 'report.json')])
    dropLaunchdJobEnv(env)
    expect(env).toEqual({
      NODE_OPTIONS: '--max-old-space-size=4096',
      NODE_EXTRA_CA_CERTS: '/etc/ca.pem',
      PATH: '/bin'
    })
  })

  it('never throws where it cannot write', () => {
    takeLaunchdReportPath(['--launchd-report', join(dir, 'missing', 'report.json')])
    expect(() => reportToLaunchd({ type: 'started', pid: 7 })).not.toThrow()
  })
})

describe("a launchd daemon's own job", () => {
  const fakeSpawn = () => vi.fn(() => ({ unref: vi.fn(), on: vi.fn() }))
  const ownReport = () => join(dir, 'codes.pod.daemon.abc.n1.report.json')

  it('is booted out by a detached launchctl when the daemon exits', () => {
    takeLaunchdReportPath(['--launchd-report', ownReport()])
    const spawn = fakeSpawn()
    const target = new EventEmitter()
    bootoutOwnLaunchdJobAtExit('codes.pod.daemon.abc.n1', spawn, target)
    expect(spawn).not.toHaveBeenCalled()
    target.emit('exit')
    expect(spawn).toHaveBeenCalledWith({
      program: '/bin/launchctl',
      args: ['bootout', `gui/${process.getuid?.()}/codes.pod.daemon.abc.n1`],
      detached: true,
      stdio: 'ignore'
    })
  })

  it('is left alone unless it is the job this launch was given', () => {
    takeLaunchdReportPath(['--launchd-report', ownReport()])
    const spawn = fakeSpawn()
    const target = new EventEmitter()
    bootoutOwnLaunchdJobAtExit(undefined, spawn, target)
    bootoutOwnLaunchdJobAtExit('application.codes.pod.app.1234', spawn, target)
    // A Pod label, but not the one in this daemon's report path.
    bootoutOwnLaunchdJobAtExit('codes.pod.daemon.abc.other', spawn, target)
    takeLaunchdReportPath([])
    bootoutOwnLaunchdJobAtExit('codes.pod.daemon.abc.n1', spawn, target)
    target.emit('exit')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('reports ready before it arms the bootout', () => {
    takeLaunchdReportPath(['--launchd-report', ownReport()])
    const once = vi.spyOn(process, 'once').mockImplementation(() => process)
    reportLaunchdReady({ pid: 7, startedAtMs: 1 }, 'codes.pod.daemon.abc.n1')
    expect(readDaemonLaunchdReport(ownReport())).toEqual({ type: 'ready', pid: 7, startedAtMs: 1 })
    expect(once).toHaveBeenCalledWith('exit', expect.any(Function))
    once.mockRestore()
  })
})
