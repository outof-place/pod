import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ENTRY_REL,
  buildBundleFixture,
  fakeTool,
  hostApp,
  installHostApp,
  type ToolState
} from './daemon-host-darwin.test-fixture'

const tools = vi.hoisted((): ToolState => ({
  calls: [],
  codesignCode: 0,
  lsofStdout: ''
}))

vi.mock('@orca/process-host', () => ({
  runProcess: vi.fn(async (spec) => fakeTool(tools, spec))
}))

import { darwinDaemonHostNeedsClone, getDarwinDaemonHostRootDir } from './daemon-host-darwin-clone'
import {
  pruneDarwinDaemonHosts,
  scheduleDarwinDaemonHostMaintenance
} from './daemon-host-darwin-prune'
import type { PinnedDaemonVersionsEvidence } from './daemon-host-relocation'

let tempDir: string
let entryPath: string
const originalPlatform = process.platform
const originalExecPath = process.execPath

function setProcessProp(key: string, value: unknown): void {
  Object.defineProperty(process, key, {
    value,
    configurable: true,
    writable: true
  })
}

// A published clone of `version`, with a read-only dir the bundle may carry.
function publishClone(version: string, name = 'build-0123456789abcdef-aabbccddeeff'): string {
  const buildDir = join(getDarwinDaemonHostRootDir(), version, name)
  buildBundleFixture(buildDir, 'Pod Runtime')
  const readOnly = join(buildDir, 'Pod Runtime', 'Contents', 'Resources', 'claude-acc')
  mkdirSync(readOnly, { recursive: true })
  chmodSync(readOnly, 0o555)
  return buildDir
}

function exitedPid(): number {
  const pid = spawnSync(originalExecPath, ['-e', '0']).pid
  if (!pid) {
    throw new Error('could not spawn a short-lived process')
  }
  return pid
}

const complete = (live: Record<string, 'live' | 'exited'>): PinnedDaemonVersionsEvidence => ({
  status: 'complete',
  versionLiveness: new Map(Object.entries(live).map(([version, status]) => [version, { status }]))
})

beforeEach(() => {
  tempDir = realpathSync(mkdtempSync(join(os.tmpdir(), 'darwin-daemon-host-prune-')))
  const fixture = buildBundleFixture(join(tempDir, 'Applications'))
  hostApp.isPackaged = true
  hostApp.userDataPath = join(tempDir, 'userData')
  hostApp.appPath = join(fixture.bundleDir, 'Contents', 'Resources', 'app.asar')
  entryPath = join(fixture.bundleDir, ENTRY_REL)
  hostApp.version = '9.9.9'
  installHostApp()
  setProcessProp('platform', 'darwin')
  setProcessProp('execPath', fixture.execPath)
  tools.calls = []
  tools.lsofStdout = ''
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
  setProcessProp('platform', originalPlatform)
  setProcessProp('execPath', originalExecPath)
  vi.restoreAllMocks()
  spawnSync('/bin/chmod', ['-R', 'u+w', tempDir])
  rmSync(tempDir, { recursive: true, force: true })
})

describe('pruneDarwinDaemonHosts', () => {
  it('reclaims an unpinned old version, read-only dirs included, and keeps the rest', async () => {
    const old = publishClone('1.0.0')
    const pinned = publishClone('2.0.0')
    const current = publishClone('9.9.9')
    await pruneDarwinDaemonHosts(complete({ '2.0.0': 'live' }))
    expect(existsSync(join(old, '..'))).toBe(false)
    expect(existsSync(pinned)).toBe(true)
    expect(existsSync(current)).toBe(true)
    // chmod runs before the removal; lsof was asked about the old version's executable only.
    const programs = tools.calls.map((call) => call.program)
    expect(programs.indexOf('/bin/chmod')).toBeGreaterThan(programs.indexOf('/usr/sbin/lsof'))
    expect(tools.calls.filter((call) => call.program === '/usr/sbin/lsof')).toHaveLength(1)
    expect(tools.calls[0].args.at(-1)).toBe(join(old, 'Pod Runtime', 'Contents', 'MacOS', 'Pod'))
  })

  it('keeps every version when the pid records cannot be read', async () => {
    const old = publishClone('1.0.0')
    await pruneDarwinDaemonHosts({ status: 'unverifiable', reason: 'test' })
    expect(existsSync(old)).toBe(true)
    expect(tools.calls).toEqual([])
  })

  it('keeps a version whose executable a running process still maps', async () => {
    const old = publishClone('1.0.0')
    tools.lsofStdout = '4242\n'
    await pruneDarwinDaemonHosts(complete({}))
    expect(existsSync(old)).toBe(true)
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('a process still runs from it')
    )
  })

  it('reclaims staging of an exited writer and keeps a live writer’s', async () => {
    const versionDir = join(getDarwinDaemonHostRootDir(), '9.9.9')
    const abandoned = join(versionDir, `.staging-${exitedPid()}-aabbccddeeff`)
    const inProgress = join(versionDir, `.staging-${process.pid}-aabbccddeeff`)
    buildBundleFixture(abandoned, 'Pod Runtime')
    buildBundleFixture(inProgress, 'Pod Runtime')
    await pruneDarwinDaemonHosts(complete({}))
    expect(existsSync(abandoned)).toBe(false)
    expect(existsSync(inProgress)).toBe(true)
  })

  it('does nothing off macOS', async () => {
    const old = publishClone('1.0.0')
    setProcessProp('platform', 'linux')
    await pruneDarwinDaemonHosts(complete({}))
    expect(existsSync(old)).toBe(true)
  })
})

describe('scheduleDarwinDaemonHostMaintenance', () => {
  it('prunes unpinned versions, then clones the current one off the startup path', async () => {
    const old = publishClone('1.0.0')
    const runtimeDir = join(tempDir, 'userData', 'daemon')
    mkdirSync(runtimeDir, { recursive: true })
    vi.useFakeTimers()
    try {
      scheduleDarwinDaemonHostMaintenance(runtimeDir, entryPath)
      expect(tools.calls).toEqual([])
      await vi.advanceTimersByTimeAsync(30_000)
    } finally {
      vi.useRealTimers()
    }
    await vi.waitFor(() => expect(darwinDaemonHostNeedsClone(entryPath)).toBe(false))
    expect(existsSync(old)).toBe(false)
  })
})
