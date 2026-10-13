import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
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
