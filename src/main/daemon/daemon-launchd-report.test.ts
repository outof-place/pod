import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bootoutOwnLaunchdJobAtExit,
  dropLaunchdJobEnv,
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

  it('never throws where it cannot write', () => {
    takeLaunchdReportPath(['--launchd-report', join(dir, 'missing', 'report.json')])
    expect(() => reportToLaunchd({ type: 'started', pid: 7 })).not.toThrow()
  })
})

describe("a launchd daemon's own job", () => {
  const fakeSpawn = () => vi.fn(() => ({ unref: vi.fn(), on: vi.fn() }))

  it('is booted out by a detached launchctl when the daemon exits', () => {
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

  it('is left alone unless Pod made it', () => {
    const spawn = fakeSpawn()
    const target = new EventEmitter()
    bootoutOwnLaunchdJobAtExit(undefined, spawn, target)
    bootoutOwnLaunchdJobAtExit('application.codes.pod.app.1234', spawn, target)
    target.emit('exit')
    expect(spawn).not.toHaveBeenCalled()
  })
})
