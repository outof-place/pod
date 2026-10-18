import { beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, webContentsFromIdMock, clickMoves } = vi.hoisted(() => {
  const proxyClickMoves: { takesMove: (params: Record<string, unknown>) => boolean }[] = []
  return { execFileMock: vi.fn(), webContentsFromIdMock: vi.fn(), clickMoves: proxyClickMoves }
})

vi.mock('child_process', () => ({ execFile: execFileMock }))
vi.mock('node:child_process', () => ({ execFile: execFileMock }))
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/app'), getAppPath: vi.fn(() => '/project'), isPackaged: false },
  webContents: { fromId: webContentsFromIdMock }
}))
vi.mock('./cdp-ws-proxy', () => ({
  CdpWsProxy: vi.fn().mockImplementation(function (
    this: Record<string, unknown>,
    _wc: unknown,
    _hold: unknown,
    hints: { clickMove: { takesMove: (params: Record<string, unknown>) => boolean } }
  ) {
    clickMoves.push(hints.clickMove)
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

const MOVE = { type: 'mouseMoved', x: 10, y: 20 }

describe('AgentBrowserBridge click pointer move', () => {
  let bridge: AgentBrowserBridge
  // Per agent-browser command: whether the proxy would answer a pointer move at once, twice over.
  let answeredAtOnce: Record<string, boolean[]> = {}

  beforeEach(() => {
    vi.clearAllMocks()
    clickMoves.length = 0
    answeredAtOnce = {}
    webContentsFromIdMock.mockReturnValue(mockWebContents(100))
    execFileMock.mockImplementation(
      (_bin: string, args: string[], _opts: unknown, cb: ExecFileCallback) => {
        const verb = ['click', 'dblclick', 'hover'].find((name) => args.includes(name))
        if (verb && clickMoves[0]) {
          answeredAtOnce[verb] = [clickMoves[0].takesMove(MOVE), clickMoves[0].takesMove(MOVE)]
        }
        cb(null, JSON.stringify({ success: true, data: {} }), '')
        return createFakeAgentBrowserChild({ stdin: { on: vi.fn(), end: vi.fn() } })
      }
    )
    bridge = new AgentBrowserBridge(mockBrowserManager())
    bridge.setActiveTab(100)
  })

  it("answers a click's one pointer move at once, not a hover's, and nothing after the click", async () => {
    await bridge.click('@e1')
    await bridge.dblclick('@e1')
    await bridge.hover('@e1')

    expect(answeredAtOnce).toEqual({
      click: [true, false],
      dblclick: [true, false],
      hover: [false, false]
    })
    expect(clickMoves[0]?.takesMove(MOVE)).toBe(false)
  })
})
