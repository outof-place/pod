import { mkdtempSync, rmSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, webContentsFromIdMock, proxyStops } = vi.hoisted(() => {
  const stops: ReturnType<typeof vi.fn>[] = []
  return { execFileMock: vi.fn(), webContentsFromIdMock: vi.fn(), proxyStops: stops }
})

vi.mock('child_process', () => ({ execFile: execFileMock }))
vi.mock('node:child_process', () => ({ execFile: execFileMock }))
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/app'), getAppPath: vi.fn(() => '/project'), isPackaged: false },
  webContents: { fromId: webContentsFromIdMock }
}))
vi.mock('./cdp-ws-proxy', () => ({
  CdpWsProxy: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    const stop = vi.fn(async () => {})
    this.start = vi.fn(async () => 'ws://127.0.0.1:9222')
    this.stop = stop
    this.getPort = vi.fn(() => 9222)
    proxyStops.push(stop)
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

const FIVE_MINUTES = 5 * 60 * 1000
let directory = ''
let previousSocketDir: string | undefined
// The CLI's pending replies, by command: a `wait` answers only when the test says so.
let heldWait: ExecFileCallback | null = null
let holdClose = false
let heldClose: ExecFileCallback | null = null

// The first command of a session closes a stale daemon of the same name before it starts.
function closes(): number {
  const argvs: string[][] = execFileMock.mock.calls.map((call) => call[1])
  return argvs.filter((args) => args.includes('close')).length
}

describe('AgentBrowserBridge retires an idle tab daemon', () => {
  let bridge: AgentBrowserBridge

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    proxyStops.length = 0
    heldWait = null
    holdClose = false
    heldClose = null
    directory = mkdtempSync('/tmp/abr-')
    previousSocketDir = process.env.AGENT_BROWSER_SOCKET_DIR
    process.env.AGENT_BROWSER_SOCKET_DIR = directory
    webContentsFromIdMock.mockReturnValue(mockWebContents(100))
    execFileMock.mockImplementation(
      (_bin: string, args: string[], _opts: unknown, cb: ExecFileCallback) => {
        if (args.includes('wait')) {
          heldWait = cb
        } else if (holdClose && args.includes('close')) {
          heldClose = cb
        } else {
          cb(null, JSON.stringify({ success: true, data: {} }), '')
        }
        return createFakeAgentBrowserChild({ stdin: { on: vi.fn(), end: vi.fn() } })
      }
    )
    bridge = new AgentBrowserBridge(mockBrowserManager())
    bridge.setActiveTab(100)
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(directory, { recursive: true, force: true })
    if (previousSocketDir === undefined) {
      delete process.env.AGENT_BROWSER_SOCKET_DIR
    } else {
      process.env.AGENT_BROWSER_SOCKET_DIR = previousSocketDir
    }
  })

  it('five minutes after its last command, not ten, and keeps the CDP proxy', async () => {
    await bridge.snapshot()
    await vi.advanceTimersByTimeAsync(FIVE_MINUTES - 1_000)
    expect(closes()).toBe(1)

    await vi.advanceTimersByTimeAsync(1_000)

    expect(closes()).toBe(2)
    expect(proxyStops[0]).not.toHaveBeenCalled()
  })

  it('retires a daemon once: an idle tab without one spawns no more closes', async () => {
    await bridge.snapshot()
    await vi.advanceTimersByTimeAsync(3 * FIVE_MINUTES)
    expect(closes()).toBe(2)
  })

  it('counts from the last command, and never during one: a six-minute wait is not cut', async () => {
    await bridge.snapshot()
    await vi.advanceTimersByTimeAsync(FIVE_MINUTES - 1_000)
    const wait = bridge.wait({ selector: '#done', timeout: 400_000 })
    await vi.advanceTimersByTimeAsync(6 * 60 * 1000)
    expect(closes()).toBe(1)

    heldWait?.(null, JSON.stringify({ success: true, data: { waited: true } }), '')
    await wait
    await vi.advanceTimersByTimeAsync(FIVE_MINUTES - 1_000)
    expect(closes()).toBe(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(closes()).toBe(2)
  })

  it('holds a command that arrives while the daemon closes until it is gone', async () => {
    await bridge.snapshot()
    holdClose = true
    await vi.advanceTimersByTimeAsync(FIVE_MINUTES)
    expect(heldClose).not.toBeNull()

    const click = bridge.click('@e1')
    await vi.advanceTimersByTimeAsync(0)
    const clicks = (): number => {
      const argvs: string[][] = execFileMock.mock.calls.map((call) => call[1])
      return argvs.filter((args) => args.includes('click')).length
    }
    expect(clicks()).toBe(0)

    heldClose?.(null, JSON.stringify({ success: true, data: {} }), '')
    await click
    expect(clicks()).toBe(1)
  })

  it('keeps a daemon that holds network routes an agent set', async () => {
    await bridge.interceptEnable(['**/api/*'])
    await vi.advanceTimersByTimeAsync(9 * 60 * 1000)
    expect(closes()).toBe(1)
  })

  it('starts a fresh daemon through the CLI for the next command', async () => {
    await bridge.snapshot()
    await vi.advanceTimersByTimeAsync(FIVE_MINUTES)
    execFileMock.mockClear()

    await bridge.click('@e1')

    const args: string[] = execFileMock.mock.calls.at(-1)?.[1] ?? []
    expect(args.slice(0, 4)).toEqual(['--session', 'orca-tab-tab-1', '--cdp', '9222'])
    expect(args).toContain('click')
  })
})
