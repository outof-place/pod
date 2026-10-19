// The pane controller's test page: a fake offscreen WebContents and its window, a frame sender, and
// a controller tracking one page (pod-browser-pane.test.ts, pod-browser-pane-cobrowse-capture.test.ts).
import { EventEmitter } from 'node:events'
import { vi } from 'vitest'
import { PodBrowserPaneController } from './pod-browser-pane'
import type { PodBrowserFrames } from './pod-browser-pane-frames'
import type { PodBrowserPaneServerMessage } from './pod-browser-pane-protocol'

export class FakeWebContents extends EventEmitter {
  id = 41
  url = 'https://example.com/'
  destroyed = false
  painting = true
  history = { back: false, forward: false }
  readonly calls: string[] = []
  readonly inputs: unknown[] = []
  navigationHistory = {
    canGoBack: () => this.history.back,
    canGoForward: () => this.history.forward,
    goBack: () => this.calls.push('goBack'),
    goForward: () => this.calls.push('goForward')
  }
  isDestroyed = () => this.destroyed
  zoomLevel = 0
  getZoomLevel = () => this.zoomLevel
  setZoomLevel = (level: number) => {
    this.zoomLevel = level
  }
  getZoomFactor = () => 1.2 ** this.zoomLevel
  reloadIgnoringCache = () => this.calls.push('reloadIgnoringCache')
  getURL = () => this.url
  getTitle = () => 'Example'
  isLoading = () => false
  startPainting = () => {
    this.painting = true
  }
  stopPainting = () => {
    this.painting = false
  }
  setFrameRate = vi.fn()
  invalidate = vi.fn()
  sendInputEvent = (input: unknown) => this.inputs.push(input)
  insertText = vi.fn(async () => {})
  copy = () => this.calls.push('copy')
  reload = () => this.calls.push('reload')
  stop = () => this.calls.push('stop')
  loadURL = vi.fn(async () => {})
  findInPage = vi.fn()
  stopFindInPage = vi.fn()
  focus = vi.fn()
  // The page's debugger as co-browse reaches it: `cdp` answers each method (a test sets it).
  cdp: (method: string, params: Record<string, unknown>) => unknown = () => ({})
  debuggerAttached = false
  debugger = {
    isAttached: () => this.debuggerAttached,
    attach: () => {
      this.debuggerAttached = true
    },
    detach: () => {
      this.debuggerAttached = false
    },
    sendCommand: async (method: string, params: Record<string, unknown> = {}) =>
      this.cdp(method, params)
  }
  isCrashed = () => false
  executeJavaScriptInIsolatedWorld = vi.fn(
    async (_world: number, _sources: { code: string }[]) => {}
  )
}

export class FakeWindow {
  size = [1280, 800]
  constructor(readonly webContents: FakeWebContents) {}
  getContentSize = () => this.size
  setContentSize = (width: number, height: number) => {
    this.size = [width, height]
  }
}

export function setup(
  frames: PodBrowserFrames | null = fakeFrames(),
  mainDisplayScale?: () => number
) {
  const sent: PodBrowserPaneServerMessage[] = []
  const devTools = vi.fn()
  const panes = new PodBrowserPaneController({
    frames,
    send: (message) => {
      sent.push(message)
      return true
    },
    openDevTools: devTools,
    log: vi.fn(),
    mainDisplayScale
  })
  const wc = new FakeWebContents()
  const win = new FakeWindow(wc)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fakes implement every member the controller calls.
  panes.trackPage('page-1', win as unknown as Electron.BrowserWindow)
  return { panes, wc, win, sent, devTools }
}

export function fakeFrames(): PodBrowserFrames {
  return {
    browserConnect: vi.fn(() => true),
    browserDisconnect: vi.fn(() => true),
    browserSend: vi.fn(() => ({ ok: true, ns: 9000 }))
  }
}

export function texture(widgetType: 'frame' | 'popup' = 'frame') {
  return {
    release: vi.fn(),
    textureInfo: {
      widgetType,
      contentRect: { x: 30.4, y: 40.6, width: 100, height: 50 },
      handle: { ioSurface: Buffer.alloc(8) }
    }
  }
}

export const attach = {
  type: 'browserAttach',
  pageId: 'page-1',
  token: 7,
  width: 900,
  height: 700,
  scale: 2
} as const
export const rendezvous = {
  type: 'browserRendezvous',
  service: 'codes.pod.native.browser.0123456789abcdef0123456789abcdef'
} as const
