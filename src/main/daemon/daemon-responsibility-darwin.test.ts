import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Responsibility from './daemon-responsibility-darwin'

const { existsSync } = vi.hoisted(() => ({ existsSync: vi.fn((_path: string) => true) }))
vi.mock('node:fs', () => ({ existsSync }))

const APP = '/Applications/Pod.app/Contents/Helpers/Pod Runtime.app/Contents'
const CLONE = '/u/Library/Application Support/Pod/daemon-host.noindex/1.0.0/build-x/Pod Runtime'
const ENTRY = `${CLONE}/Contents/Resources/app.asar.unpacked/out/main/daemon-entry.js`
const NODE_EXEC_PATH = process.execPath

async function load(): Promise<typeof Responsibility> {
  vi.resetModules()
  return import('./daemon-responsibility-darwin')
}

function defineProcessValue(key: string, target: object, value: string | undefined): void {
  Object.defineProperty(target, key, { value, configurable: true, writable: true })
}

beforeEach(() => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  vi.stubEnv('POD_DAEMON_DISCLAIM', undefined)
  vi.stubEnv('POD_DAEMON_APP_POLICY', undefined)
  vi.stubEnv('POD_AGENT_LAUNCHER_BINARY', undefined)
  defineProcessValue('electron', process.versions, '45.0.0')
  defineProcessValue('resourcesPath', process, `${APP}/Resources`)
  defineProcessValue(
    'helperExecPath',
    process,
    `${APP}/Frameworks/Pod Helper.app/Contents/MacOS/Pod Helper`
  )
  existsSync.mockImplementation(() => true)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  Reflect.deleteProperty(process.versions, 'electron')
  Reflect.deleteProperty(process, 'resourcesPath')
  Reflect.deleteProperty(process, 'helperExecPath')
  defineProcessValue('execPath', process, NODE_EXEC_PATH)
})

describe('disclaimedDaemonLaunch', () => {
  it('runs a relocated daemon through its clone launcher, then taskpolicy -a, then its own image', async () => {
    const { disclaimedDaemonLaunch } = await load()
    expect(
      disclaimedDaemonLaunch(ENTRY, ['--socket', '/s'], `${CLONE}/Contents/MacOS/Pod`)
    ).toEqual({
      program: `${CLONE}/Contents/Resources/bin/pod-agent-launcher`,
      args: [
        '--disclaim-exec',
        '/usr/sbin/taskpolicy',
        '-a',
        `${CLONE}/Contents/MacOS/Pod`,
        ENTRY,
        '--socket',
        '/s'
      ]
    })
  })

  it("runs a daemon without a clone as the app's own executable, not the Helper", async () => {
    defineProcessValue('execPath', process, `${APP}/MacOS/Pod`)
    const { disclaimedDaemonLaunch } = await load()
    expect(disclaimedDaemonLaunch('/app/daemon-entry.js', [])).toEqual({
      program: `${APP}/Resources/bin/pod-agent-launcher`,
      args: [
        '--disclaim-exec',
        '/usr/sbin/taskpolicy',
        '-a',
        `${APP}/MacOS/Pod`,
        '/app/daemon-entry.js'
      ]
    })
  })

  it('still disclaims with the app scheduling policy switched off', async () => {
    vi.stubEnv('POD_DAEMON_APP_POLICY', '0')
    const { disclaimedDaemonLaunch } = await load()
    expect(disclaimedDaemonLaunch(ENTRY, ['-x'], `${CLONE}/Contents/MacOS/Pod`)?.args).toEqual([
      '--disclaim-exec',
      `${CLONE}/Contents/MacOS/Pod`,
      ENTRY,
      '-x'
    ])
  })

  it("takes a checkout's launcher when the app ships none", async () => {
    vi.stubEnv('POD_AGENT_LAUNCHER_BINARY', '/repo/out/pod-agent-launcher')
    existsSync.mockImplementation((path: string) => !path.startsWith(APP))
    const { disclaimedDaemonLaunch } = await load()
    expect(disclaimedDaemonLaunch('/app/daemon-entry.js', [])?.program).toBe(
      '/repo/out/pod-agent-launcher'
    )
  })

  it('keeps the plain launch off macOS, when switched off, and outside Electron without a clone', async () => {
    const { disclaimedDaemonLaunch } = await load()
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    expect(disclaimedDaemonLaunch(ENTRY, [], `${CLONE}/Contents/MacOS/Pod`)).toBeNull()
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    vi.stubEnv('POD_DAEMON_DISCLAIM', '0')
    expect(disclaimedDaemonLaunch(ENTRY, [], `${CLONE}/Contents/MacOS/Pod`)).toBeNull()
    vi.stubEnv('POD_DAEMON_DISCLAIM', undefined)
    Reflect.deleteProperty(process.versions, 'electron')
    expect(disclaimedDaemonLaunch('/app/daemon-entry.js', [])).toBeNull()
  })

  it('keeps the plain launch without a launcher, and says so once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    existsSync.mockImplementation((path: string) => !path.endsWith('pod-agent-launcher'))
    const { disclaimedDaemonLaunch } = await load()
    expect(disclaimedDaemonLaunch(ENTRY, [], `${CLONE}/Contents/MacOS/Pod`)).toBeNull()
    expect(disclaimedDaemonLaunch(ENTRY, [], `${CLONE}/Contents/MacOS/Pod`)).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('no pod-agent-launcher')
  })
})

describe('reportDaemonDisclaimFallback', () => {
  it("logs the launcher's line and nothing else a starting daemon printed", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { reportDaemonDisclaimFallback } = await load()
    reportDaemonDisclaimFallback('(node:1) Warning: something\n')
    expect(warn).not.toHaveBeenCalled()
    reportDaemonDisclaimFallback(
      'pod-agent-launcher: /usr/sbin/taskpolicy starts without its own responsibility (x)\n(node:1) Warning\n'
    )
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      '[daemon] pod-agent-launcher: /usr/sbin/taskpolicy starts without its own responsibility (x)'
    )
  })
})
