import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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

vi.mock('@orca/process-host', () => ({
  runProcess: vi.fn(async (spec) => fakeTool(tools, spec))
}))

import { podAssessPath } from './daemon-host-darwin-assess'
import { materializeDarwinDaemonHost } from './daemon-host-darwin-clone'

let tempDir: string
let bundleDir: string
let entryPath: string
const originalPlatform = process.platform
const originalExecPath = process.execPath

function setProcessProp(key: string, value: unknown): void {
  Object.defineProperty(process, key, { value, configurable: true, writable: true })
}

function assessCalls(): readonly string[][] {
  return tools.calls
    .filter((call) => call.program.endsWith('/pod-assess'))
    .map((call) => [...call.args])
}

function installPodAssess(): string {
  const tool = podAssessPath(bundleDir)
  mkdirSync(dirname(tool), { recursive: true })
  writeFileSync(tool, '')
  return tool
}

beforeEach(() => {
  tempDir = realpathSync(mkdtempSync(join(os.tmpdir(), 'darwin-daemon-host-assess-')))
  const fixture = buildBundleFixture(join(tempDir, 'Pod.app', 'Contents', 'Helpers'))
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
  tools.assessCode = 0
  tools.assessGate = undefined
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
  setProcessProp('platform', originalPlatform)
  setProcessProp('execPath', originalExecPath)
  vi.restoreAllMocks()
  rmSync(tempDir, { recursive: true, force: true })
})

describe('daemon-host clone assessment', () => {
  it('finds pod-assess in the outer app beside its Helpers', () => {
    expect(podAssessPath(bundleDir)).toBe(
      join(tempDir, 'Pod.app', 'Contents', 'MacOS', 'pod-assess')
    )
  })

  it('has the published clone assessed, at background priority', async () => {
    const tool = installPodAssess()
    const host = await materializeDarwinDaemonHost(entryPath)
    const clone = dirname(dirname(dirname(host!.execPath)))
    await vi.waitFor(
      () => expect(assessCalls()).toEqual([['--bundle', clone]]),
      BACKGROUND_WORK_WAIT
    )
    if (
      process.platform === 'darwin' &&
      tools.calls.some((call) => call.program === '/usr/sbin/taskpolicy')
    ) {
      expect(tools.calls).toContainEqual({
        program: '/usr/sbin/taskpolicy',
        args: ['-b', tool, '--bundle', clone]
      })
    }
  })

  it('assesses a background clone while staged as a bundle, before it is published', async () => {
    installPodAssess()
    const host = await materializeDarwinDaemonHost(entryPath, { background: true })
    const calls = assessCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0][1]).toMatch(/\/\.staging-\d+-[0-9a-f]+\/Pod Runtime\.app$/)
    // Published without `.app`, so LaunchServices never registers it.
    expect(host!.execPath).toMatch(
      /\/build-[0-9a-f]+-[0-9a-f]+\/Pod Runtime\/Contents\/MacOS\/Pod$/
    )
  })

  it('forks from the clone without waiting for the assessment', async () => {
    installPodAssess()
    let release: () => void = () => {}
    tools.assessGate = new Promise<void>((resolve) => {
      release = resolve
    })
    expect(await materializeDarwinDaemonHost(entryPath)).not.toBeNull()
    await vi.waitFor(() => expect(assessCalls()).toHaveLength(1), BACKGROUND_WORK_WAIT)
    release()
  })

  it('assesses nothing without pod-assess', async () => {
    expect(await materializeDarwinDaemonHost(entryPath)).not.toBeNull()
    expect(assessCalls()).toEqual([])
  })

  it('reports a failed assessment and keeps the clone', async () => {
    installPodAssess()
    tools.assessCode = 1
    expect(await materializeDarwinDaemonHost(entryPath)).not.toBeNull()
    await vi.waitFor(
      () =>
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('pod-assess exited 1')),
      BACKGROUND_WORK_WAIT
    )
  })
})
