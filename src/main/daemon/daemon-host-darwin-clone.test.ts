import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BACKGROUND_WORK_WAIT,
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

vi.mock('./daemon-host-darwin-volume', async (importOriginal) => ({
  ...(await importOriginal<typeof VolumeModule>()),
  freeBytes: () => tools.freeBytes ?? Number.MAX_SAFE_INTEGER
}))

vi.mock('@orca/process-host', () => ({
  runProcess: vi.fn(async (spec) => fakeTool(tools, spec))
}))

import { darwinDaemonHostForSpawn } from './daemon-host-darwin-spawn'
import type * as VolumeModule from './daemon-host-darwin-volume'
import {
  DARWIN_HOST_MARKER_NAME,
  readDarwinDaemonHostMarker
} from './daemon-host-darwin-bundle-identity'
import {
  getDarwinDaemonHostRootDir,
  darwinDaemonHostNeedsClone,
  materializeDarwinDaemonHost
} from './daemon-host-darwin-clone'

let tempDir: string
let bundleDir: string
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

function versionRoot(): string {
  return join(getDarwinDaemonHostRootDir(), hostApp.version)
}

function toolCalls(program: string): number {
  return tools.calls.filter((call) => call.program === program).length
}

beforeEach(() => {
  tempDir = realpathSync(mkdtempSync(join(os.tmpdir(), 'darwin-daemon-host-')))
  const fixture = buildBundleFixture(join(tempDir, 'Applications'))
  bundleDir = fixture.bundleDir
  entryPath = join(bundleDir, ENTRY_REL)
  hostApp.isPackaged = true
  hostApp.userDataPath = join(tempDir, 'userData')
  hostApp.appPath = join(bundleDir, 'Contents', 'Resources', 'app.asar')
  hostApp.version = '9.9.9'
  installHostApp()
  setProcessProp('platform', 'darwin')
  setProcessProp('execPath', fixture.execPath)
  tools.calls = []
  tools.copyDelayMs = 0
  tools.volumeType = 'apfs'
  tools.freeBytes = undefined
  tools.codesignCode = 0
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
  setProcessProp('platform', originalPlatform)
  setProcessProp('execPath', originalExecPath)
  vi.restoreAllMocks()
  rmSync(tempDir, { recursive: true, force: true })
})

describe('materializeDarwinDaemonHost', () => {
  it('does nothing off macOS', async () => {
    setProcessProp('platform', 'linux')
    expect(await materializeDarwinDaemonHost(entryPath)).toBeNull()
    expect(existsSync(getDarwinDaemonHostRootDir())).toBe(false)
  })

  it('clones the running bundle, verifies its seal and forks from the clone', async () => {
    expect(darwinDaemonHostNeedsClone(entryPath)).toBe(true)
    const host = await materializeDarwinDaemonHost(entryPath)
    expect(host).not.toBeNull()
    const buildDir = dirname(dirname(dirname(dirname(host!.execPath))))
    expect(dirname(buildDir)).toBe(versionRoot())
    // Not `.app`, so LaunchServices never registers the clone.
    expect(host!.execPath).toBe(join(buildDir, 'Pod Runtime', 'Contents', 'MacOS', 'Pod'))
    expect(host!.entryPath).toBe(join(buildDir, 'Pod Runtime', ENTRY_REL))
    expect(existsSync(host!.entryPath)).toBe(true)
    expect(tools.calls.find((call) => call.program === '/bin/cp')?.args.slice(0, 3)).toEqual([
      '-c',
      '-R',
      bundleDir
    ])
    // Verified in staging, before anything can fork from it.
    const verifyArgs = tools.calls.find((call) => call.program === '/usr/bin/codesign')?.args
    expect(verifyArgs?.slice(0, 3)).toEqual(['--verify', '--strict', '--deep'])
    expect(verifyArgs?.[3]).toMatch(/\/\.staging-\d+-[0-9a-f]+\/Pod Runtime\.app$/)
    expect(readDarwinDaemonHostMarker(buildDir)?.version).toBe('9.9.9')
    expect(existsSync(join(getDarwinDaemonHostRootDir(), '.metadata_never_index'))).toBe(true)
    expect(readdirSync(versionRoot()).filter((name) => name.startsWith('.staging-'))).toEqual([])
    expect(darwinDaemonHostNeedsClone(entryPath)).toBe(false)
  })

  it('reuses a published clone without copying again', async () => {
    const first = await materializeDarwinDaemonHost(entryPath)
    const second = await materializeDarwinDaemonHost(entryPath)
    expect(second).toEqual(first)
    expect(toolCalls('/bin/cp')).toBe(1)
  })

  it('shares one copy between concurrent callers', async () => {
    const [left, right] = await Promise.all([
      materializeDarwinDaemonHost(entryPath),
      materializeDarwinDaemonHost(entryPath)
    ])
    expect(left).toEqual(right)
    expect(toolCalls('/bin/cp')).toBe(1)
  })

  it('reclones when something wrote into the clone after it was verified', async () => {
    const first = await materializeDarwinDaemonHost(entryPath)
    writeFileSync(join(dirname(first!.entryPath), 'stray.pyc'), 'bytecode')
    const second = await materializeDarwinDaemonHost(entryPath)
    expect(second).not.toBeNull()
    expect(second!.execPath).not.toBe(first!.execPath)
    expect(toolCalls('/bin/cp')).toBe(2)
  })

  it('reclones when the installed bundle changes', async () => {
    const first = await materializeDarwinDaemonHost(entryPath)
    writeFileSync(
      join(bundleDir, 'Contents', '_CodeSignature', 'CodeResources'),
      '<plist>v2</plist>'
    )
    const second = await materializeDarwinDaemonHost(entryPath)
    expect(second!.execPath).not.toBe(first!.execPath)
    expect(readdirSync(versionRoot()).filter((name) => name.startsWith('build-'))).toHaveLength(2)
  })

  it('records a clone on APFS and a full copy elsewhere', async () => {
    const cloned = await materializeDarwinDaemonHost(entryPath)
    expect(
      readDarwinDaemonHostMarker(dirname(dirname(dirname(dirname(cloned!.execPath)))))?.cloned
    ).toBe(true)
    tools.volumeType = 'hfs'
    writeFileSync(join(bundleDir, 'Contents', 'Info.plist'), '<plist>v2</plist>')
    const copied = await materializeDarwinDaemonHost(entryPath)
    expect(
      readDarwinDaemonHostMarker(dirname(dirname(dirname(dirname(copied!.execPath)))))?.cloned
    ).toBe(false)
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('volume cannot clone; making a full')
    )
  })

  it('forks from the bundle when a full copy would not leave the headroom', async () => {
    tools.volumeType = 'hfs'
    tools.freeBytes = 4096
    expect(await materializeDarwinDaemonHost(entryPath)).toBeNull()
    expect(toolCalls('/bin/cp')).toBe(0)
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('forking from the app bundle')
    )
  })

  it('fails open with a log line when the clone does not verify', async () => {
    tools.codesignCode = 1
    expect(await materializeDarwinDaemonHost(entryPath)).toBeNull()
    expect(readdirSync(versionRoot())).toEqual([])
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('failed seal verification'))
  })

  it('does not relocate an unsigned bundle', async () => {
    rmSync(join(bundleDir, 'Contents', '_CodeSignature'), { recursive: true })
    expect(await materializeDarwinDaemonHost(entryPath)).toBeNull()
    expect(toolCalls('/bin/cp')).toBe(0)
  })

  it('keeps the marker outside the sealed bundle', async () => {
    const host = await materializeDarwinDaemonHost(entryPath)
    const bundle = dirname(dirname(dirname(host!.execPath)))
    expect(existsSync(join(dirname(bundle), DARWIN_HOST_MARKER_NAME))).toBe(true)
    expect(existsSync(join(bundle, DARWIN_HOST_MARKER_NAME))).toBe(false)
  })
})

describe('darwinDaemonHostForSpawn', () => {
  it('forks this daemon from the bundle when the clone outlasts the budget, and keeps cloning', async () => {
    tools.copyDelayMs = 200
    expect(await darwinDaemonHostForSpawn(entryPath, 20)).toBeNull()
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('no clone within 20 ms'))
    await vi.waitFor(
      () => expect(darwinDaemonHostNeedsClone(entryPath)).toBe(false),
      BACKGROUND_WORK_WAIT
    )
    expect(await darwinDaemonHostForSpawn(entryPath, 20)).not.toBeNull()
  })
})
