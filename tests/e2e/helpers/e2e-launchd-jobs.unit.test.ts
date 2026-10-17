import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { daemonLaunchdLabelPrefix } from '../../../src/main/daemon/daemon-launchd-jobs-darwin'

const launchctl = vi.hoisted(() => ({
  loaded: [] as string[],
  stuck: [] as string[],
  calls: [] as string[][]
}))
vi.mock('node:child_process', () => ({
  execFileSync: (_program: string, args: string[]) => {
    launchctl.calls.push(args)
    if (args[0] === 'list') {
      return `PID\tStatus\tLabel\n${launchctl.loaded.map((label) => `-\t9\t${label}`).join('\n')}\n`
    }
    if (args[0] === 'bootout') {
      const label = args[1]?.split('/').pop()
      launchctl.loaded = launchctl.loaded.filter(
        (loaded) => loaded !== label || launchctl.stuck.includes(loaded)
      )
    }
    return ''
  }
}))

const { bootoutE2ELaunchdJobs } = await import('./e2e-launchd-jobs')
const originalPlatform = process.platform
let userDataDir: string

beforeEach(() => {
  userDataDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-launchd-'))
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  launchctl.loaded = []
  launchctl.stuck = []
  launchctl.calls = []
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  rmSync(userDataDir, { recursive: true, force: true })
})

describe('E2E teardown of launchd daemon jobs', () => {
  it("boots out only its profile's jobs and leaves none", () => {
    const own = `${daemonLaunchdLabelPrefix(userDataDir)}nonce-1`
    const other = 'codes.pod.daemon.000000000000.nonce-2'
    launchctl.loaded = [own, other]
    bootoutE2ELaunchdJobs(userDataDir)
    expect(launchctl.loaded).toEqual([other])
    expect(launchctl.calls.filter((args) => args[0] === 'bootout')).toEqual([
      ['bootout', `gui/${process.getuid?.()}/${own}`]
    ])
  })

  it('fails when a job of the profile stays loaded', () => {
    const own = `${daemonLaunchdLabelPrefix(userDataDir)}stuck`
    launchctl.loaded = [own]
    launchctl.stuck = [own]
    expect(() => bootoutE2ELaunchdJobs(userDataDir)).toThrow(/left 1 launchd job/)
  })
})
