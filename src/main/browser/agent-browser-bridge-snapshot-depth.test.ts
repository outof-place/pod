import { beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, webContentsFromIdMock, narrowings } = vi.hoisted(() => {
  const proxyNarrowings: { narrows: (params: Record<string, unknown>) => boolean }[] = []
  return { execFileMock: vi.fn(), webContentsFromIdMock: vi.fn(), narrowings: proxyNarrowings }
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
    hints: { snapshotNarrowing: { narrows: (params: Record<string, unknown>) => boolean } }
  ) {
    narrowings.push(hints.snapshotNarrowing)
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

describe('AgentBrowserBridge snapshot depth', () => {
  let bridge: AgentBrowserBridge
  // Whether the proxy would cut the tree while each snapshot command runs.
  let narrowedDuring: boolean[] = []

  beforeEach(() => {
    vi.clearAllMocks()
    narrowings.length = 0
    narrowedDuring = []
    webContentsFromIdMock.mockReturnValue(mockWebContents(100))
    execFileMock.mockImplementation(
      (_bin: string, args: string[], _opts: unknown, cb: ExecFileCallback) => {
        if (args.includes('snapshot')) {
          narrowedDuring.push(narrowings[0]?.narrows({}) ?? false)
        }
        cb(null, JSON.stringify({ success: true, data: { snapshot: '' } }), '')
        return createFakeAgentBrowserChild({ stdin: { on: vi.fn(), end: vi.fn() } })
      }
    )
    bridge = new AgentBrowserBridge(mockBrowserManager())
    bridge.setActiveTab(100)
  })

  it('lets the proxy cut the tree for --depth, not for a full or selector snapshot, and not after', async () => {
    await bridge.snapshot(undefined, undefined, { depth: 2 })
    await bridge.snapshot()
    await bridge.snapshot(undefined, undefined, { depth: 2, selector: 'table' })

    expect(narrowedDuring).toEqual([true, false, false])
    expect(narrowings[0]?.narrows({})).toBe(false)
  })
})
