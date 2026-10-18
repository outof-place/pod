import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, webContentsFromIdMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  webContentsFromIdMock: vi.fn()
}))

vi.mock('child_process', () => ({ execFile: execFileMock }))
vi.mock('node:child_process', () => ({ execFile: execFileMock }))
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/app'), getAppPath: vi.fn(() => '/project'), isPackaged: false },
  webContents: { fromId: webContentsFromIdMock }
}))
vi.mock('./cdp-ws-proxy', () => ({
  CdpWsProxy: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.start = vi.fn(async () => 'ws://127.0.0.1:9222')
    this.stop = vi.fn(async () => {})
    this.getPort = vi.fn(() => 9222)
  })
}))
vi.mock('./cdp-bridge', () => ({
  BrowserError: class BrowserError extends Error {
    constructor(
      readonly code: string,
      message: string
    ) {
      super(message)
    }
  }
}))

import { AgentBrowserBridge } from './agent-browser-bridge'
import {
  createFakeAgentBrowserChild,
  mockBrowserManager,
  mockWebContents,
  overrideBridgeWebContentsLookup,
  type ExecFileCallback
} from './agent-browser-bridge-test-harness'

overrideBridgeWebContentsLookup(AgentBrowserBridge.prototype, webContentsFromIdMock)

const SESSION = 'orca-tab-tab-1'

let directory = ''
let daemon: Server | null = null
let daemonLines: Record<string, unknown>[] = []
let previousSocketDir: string | undefined

// The CLI as the bridge spawns it: every call succeeds with `data`.
function cliAnswers(data: unknown): void {
  execFileMock.mockImplementation(
    (_bin: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
      cb(null, JSON.stringify({ success: true, data }), '')
      return createFakeAgentBrowserChild({ stdin: { on: vi.fn(), end: vi.fn() } })
    }
  )
}

// What the CLI leaves behind once it started the session's daemon: its socket and version file.
async function startDaemon(
  reply: (command: Record<string, unknown>, socket: Socket) => unknown
): Promise<void> {
  writeFileSync(join(directory, `${SESSION}.version`), '0.27.3')
  daemon = createServer((socket) => {
    let buffered = ''
    socket.on('data', (chunk) => {
      buffered += chunk.toString('utf8')
      const newline = buffered.indexOf('\n')
      if (newline === -1) {
        return
      }
      const command: Record<string, unknown> = JSON.parse(buffered.slice(0, newline))
      daemonLines.push(command)
      const answer = reply(command, socket)
      if (answer !== undefined) {
        socket.write(`${JSON.stringify(answer)}\n`)
      }
    })
  })
  await new Promise<void>((resolve) => daemon!.listen(join(directory, `${SESSION}.sock`), resolve))
}

async function stopDaemon(): Promise<void> {
  await new Promise<void>((resolve) => (daemon ? daemon.close(() => resolve()) : resolve()))
  daemon = null
}

function cliCommands(): string[][] {
  const argvs: string[][] = execFileMock.mock.calls.map((call) => call[1])
  return argvs
    .filter((args) => !args.includes('close'))
    .map((args) => args.slice(args.indexOf('--cdp') + 2, -1))
}

describe('AgentBrowserBridge over the daemon socket', () => {
  let bridge: AgentBrowserBridge

  beforeEach(() => {
    vi.clearAllMocks()
    daemonLines = []
    directory = mkdtempSync('/tmp/abb-')
    previousSocketDir = process.env.AGENT_BROWSER_SOCKET_DIR
    process.env.AGENT_BROWSER_SOCKET_DIR = directory
    webContentsFromIdMock.mockReturnValue(mockWebContents(100))
    bridge = new AgentBrowserBridge(mockBrowserManager())
    bridge.setActiveTab(100)
  })

  afterEach(async () => {
    await stopDaemon()
    rmSync(directory, { recursive: true, force: true })
    if (previousSocketDir === undefined) {
      delete process.env.AGENT_BROWSER_SOCKET_DIR
    } else {
      process.env.AGENT_BROWSER_SOCKET_DIR = previousSocketDir
    }
  })

  it('sends a click to the running daemon without starting a CLI process', async () => {
    cliAnswers({ snapshot: '- button "Save" [ref=e1]' })
    await bridge.snapshot()
    await startDaemon(() => ({ success: true, data: { clicked: '@e1' } }))
    execFileMock.mockClear()

    await expect(bridge.click('@e1')).resolves.toEqual({ clicked: '@e1' })

    expect(execFileMock).not.toHaveBeenCalled()
    expect(daemonLines).toEqual([expect.objectContaining({ action: 'click', selector: '@e1' })])
  })

  it('starts the first command of a tab through the CLI, which launches the daemon on Pod CDP', async () => {
    await startDaemon(() => ({ success: true, data: {} }))
    cliAnswers({ snapshot: '' })

    await bridge.snapshot()

    expect(daemonLines).toEqual([])
    const args: string[] = execFileMock.mock.calls.at(-1)?.[1] ?? []
    expect(args.slice(0, 4)).toEqual(['--session', SESSION, '--cdp', '9222'])
  })

  it('falls back to the CLI once the daemon retired, and keeps its routes', async () => {
    cliAnswers({})
    await bridge.interceptEnable(['**/api/*'])
    await startDaemon(() => ({ success: true, data: {} }))
    await bridge.click('@e1')
    await stopDaemon()
    execFileMock.mockClear()
    cliAnswers({ clicked: '@e2' })

    await expect(bridge.click('@e2')).resolves.toEqual({ clicked: '@e2' })

    expect(cliCommands()).toEqual([
      ['click', '@e2'],
      ['network', 'route', '**/api/*']
    ])
  })

  it('maps a daemon error like the CLI did', async () => {
    cliAnswers({})
    await bridge.snapshot()
    await startDaemon(() => ({ success: false, data: null, error: 'Unknown ref: e9' }))

    await expect(bridge.click('@e9')).rejects.toMatchObject({ code: 'browser_stale_ref' })
  })

  it('keeps commands it cannot translate on the CLI', async () => {
    cliAnswers({})
    await bridge.snapshot()
    await startDaemon(() => ({ success: true, data: {} }))
    execFileMock.mockClear()
    cliAnswers({ waited: true })

    await bridge.wait({ selector: '#done' })

    expect(daemonLines).toEqual([])
    expect(cliCommands()).toEqual([['wait', '#done']])
  })

  it('never runs a click twice: a daemon that drops the connection after reading it fails the click', async () => {
    cliAnswers({})
    await bridge.snapshot()
    await startDaemon((_command, socket) => {
      socket.destroy()
      return undefined
    })
    execFileMock.mockClear()

    await expect(bridge.click('@e1')).rejects.toThrow()

    expect(execFileMock).not.toHaveBeenCalled()
    expect(daemonLines).toEqual([expect.objectContaining({ action: 'click', selector: '@e1' })])
  })

  it('rejects an in-flight daemon command when its tab closes', async () => {
    cliAnswers({})
    await bridge.snapshot()
    await startDaemon(() => undefined)

    const click = bridge.click('@e1')
    await vi.waitFor(() => expect(daemonLines).toHaveLength(1))
    await bridge.onTabClosed(100)

    await expect(click).rejects.toMatchObject({ code: 'browser_tab_closed' })
  })
})
