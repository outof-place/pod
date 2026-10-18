import { mkdtempSync, rmSync } from 'node:fs'
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

// A page's debugger as Chromium keeps it: emulation lives while a client stays attached.
function emulatingPage() {
  const page = mockWebContents(100)
  let attached = false
  let viewport: Record<string, unknown> | null = null
  const heldCaptures: (() => void)[] = []
  page.debugger.isAttached.mockImplementation(() => attached)
  page.debugger.attach.mockImplementation(() => {
    attached = true
  })
  // EmulationHandler::Disable on detach drops every override.
  page.debugger.detach.mockImplementation(() => {
    attached = false
    viewport = null
  })
  page.debugger.sendCommand.mockImplementation(async (method, params) => {
    if (method === 'Emulation.setDeviceMetricsOverride' && typeof params === 'object' && params) {
      viewport = Object.fromEntries(Object.entries(params))
    }
    if (method === 'Page.captureScreenshot') {
      return new Promise((resolve) => heldCaptures.push(() => resolve({ data: 'png' })))
    }
    return {}
  })
  return {
    page,
    viewport: () => viewport,
    answerCaptures: () => heldCaptures.splice(0).forEach((answer) => answer())
  }
}

function closes(): number {
  const argvs: string[][] = execFileMock.mock.calls.map((call) => call[1])
  return argvs.filter((args) => args.includes('close')).length
}

describe('an idle tab daemon retires without undoing what the agent set on the page', () => {
  let bridge: AgentBrowserBridge
  let page: ReturnType<typeof emulatingPage>
  let directory = ''
  let previousSocketDir: string | undefined

  beforeEach(() => {
    // Why not every timer: the real CDP proxy binds a socket, whose callbacks must still run.
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']
    })
    vi.clearAllMocks()
    directory = mkdtempSync('/tmp/abe-')
    previousSocketDir = process.env.AGENT_BROWSER_SOCKET_DIR
    process.env.AGENT_BROWSER_SOCKET_DIR = directory
    page = emulatingPage()
    webContentsFromIdMock.mockReturnValue(page.page)
    execFileMock.mockImplementation(
      (_bin: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
        cb(null, JSON.stringify({ success: true, data: {} }), '')
        return createFakeAgentBrowserChild({ stdin: { on: vi.fn(), end: vi.fn() } })
      }
    )
    bridge = new AgentBrowserBridge(
      mockBrowserManager(undefined, undefined, { holdPaintForCapture: vi.fn(() => () => {}) })
    )
    bridge.setActiveTab(100)
  })

  afterEach(async () => {
    await bridge.onPageClosed('tab-1')
    vi.useRealTimers()
    rmSync(directory, { recursive: true, force: true })
    if (previousSocketDir === undefined) {
      delete process.env.AGENT_BROWSER_SOCKET_DIR
    } else {
      process.env.AGENT_BROWSER_SOCKET_DIR = previousSocketDir
    }
  })

  it('keeps an agent viewport: the page debugger stays attached past the idle window', async () => {
    await bridge.snapshot()
    await bridge.setViewport(1440, 900)

    await vi.advanceTimersByTimeAsync(FIVE_MINUTES + 1_000)

    expect(closes()).toBe(2)
    expect(page.page.debugger.detach).not.toHaveBeenCalled()
    expect(page.page.debugger.isAttached()).toBe(true)
    expect(page.viewport()).toMatchObject({ width: 1440, height: 900 })
  })

  it('keeps it when a capture still in flight answers after the retirement', async () => {
    await bridge.snapshot()
    await bridge.setViewport(1440, 900)
    const shot = bridge.screenshot().catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(9_000)
    expect(await shot).toBeInstanceOf(Error)

    await vi.advanceTimersByTimeAsync(FIVE_MINUTES + 1_000)
    expect(closes()).toBe(2)
    page.answerCaptures()
    await vi.advanceTimersByTimeAsync(0)

    expect(page.page.debugger.detach).not.toHaveBeenCalled()
    expect(page.page.debugger.isAttached()).toBe(true)
    expect(page.viewport()).toMatchObject({ width: 1440, height: 900 })
  })

  it('releases the debugger when the tab closes', async () => {
    await bridge.snapshot()
    await vi.advanceTimersByTimeAsync(FIVE_MINUTES + 1_000)

    await bridge.onPageClosed('tab-1')

    expect(page.page.debugger.detach).toHaveBeenCalled()
  })
})
