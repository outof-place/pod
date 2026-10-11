import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PodBrowserPaneController } from './pod-browser-pane'
import type { PodBrowserFrames } from './pod-browser-pane-frames'
import type { PodBrowserPaneServerMessage } from './pod-browser-pane-protocol'

class FakeWebContents extends EventEmitter {
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
  executeJavaScriptInIsolatedWorld = vi.fn(
    async (_world: number, _sources: { code: string }[]) => {}
  )
}

class FakeWindow {
  size = [1280, 800]
  constructor(readonly webContents: FakeWebContents) {}
  getContentSize = () => this.size
  setContentSize = (width: number, height: number) => {
    this.size = [width, height]
  }
}

function setup(frames: PodBrowserFrames | null = fakeFrames()) {
  const sent: PodBrowserPaneServerMessage[] = []
  const devTools = vi.fn()
  const panes = new PodBrowserPaneController({
    frames,
    send: (message) => {
      sent.push(message)
      return true
    },
    openDevTools: devTools,
    log: vi.fn()
  })
  const wc = new FakeWebContents()
  const win = new FakeWindow(wc)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fakes implement every member the controller calls.
  panes.trackPage('page-1', win as unknown as Electron.BrowserWindow)
  return { panes, wc, win, sent, devTools }
}

function fakeFrames(): PodBrowserFrames {
  return {
    browserConnect: vi.fn(() => true),
    browserDisconnect: vi.fn(() => true),
    browserSend: vi.fn(() => ({ ok: true, ns: 9000 }))
  }
}

function texture(widgetType: 'frame' | 'popup' = 'frame') {
  return {
    release: vi.fn(),
    textureInfo: {
      widgetType,
      contentRect: { x: 30.4, y: 40.6, width: 100, height: 50 },
      handle: { ioSurface: Buffer.alloc(8) }
    }
  }
}

const attach = {
  type: 'browserAttach',
  pageId: 'page-1',
  token: 7,
  width: 900,
  height: 700,
  scale: 2
} as const
const rendezvous = {
  type: 'browserRendezvous',
  service: 'codes.pod.native.browser.0123456789abcdef0123456789abcdef'
} as const

afterEach(() => {
  vi.useRealTimers()
})

describe('PodBrowserPaneController', () => {
  it('keeps a page it was handed from painting until a pane attaches', () => {
    const { wc } = setup()
    expect(wc.painting).toBe(false)
  })

  it('attaches: the size, 60 fps, painting, a fresh frame and the page state', () => {
    const { panes, wc, win, sent } = setup()
    panes.handle(rendezvous)
    panes.handle(attach)
    expect(win.size).toEqual([900, 700])
    expect(wc.setFrameRate).toHaveBeenCalledWith(60)
    expect(wc.painting).toBe(true)
    expect(wc.invalidate).toHaveBeenCalled()
    expect(sent).toContainEqual({
      type: 'browserState',
      pageId: 'page-1',
      url: 'https://example.com/',
      title: 'Example',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      agentDriving: false
    })
  })

  it('sends an attached page frames with its token and releases every texture at once', () => {
    const frames = fakeFrames()
    const { panes, wc } = setup(frames)
    const before = texture()
    wc.emit('paint', { texture: before })
    expect(before.release).toHaveBeenCalled()
    expect(frames.browserSend).not.toHaveBeenCalled()

    panes.handle(rendezvous)
    panes.handle(attach)
    const page = texture()
    const popup = texture('popup')
    wc.emit('paint', { texture: page })
    wc.emit('paint', { texture: popup })
    expect(frames.browserSend).toHaveBeenNthCalledWith(1, page.textureInfo.handle.ioSurface, {
      seq: 1,
      token: 7,
      widget: 0,
      popupX: 30,
      popupY: 41,
      scaleX100: 200
    })
    expect(frames.browserSend).toHaveBeenNthCalledWith(
      2,
      popup.textureInfo.handle.ioSurface,
      expect.objectContaining({ seq: 2, widget: 1 })
    )
    expect(page.release).toHaveBeenCalled()
    expect(panes.stats).toEqual({ framesSent: 2, sendFailures: 0, sendNs: 18000 })
  })

  it('sends nothing before PodNative named a receiver', () => {
    const frames = fakeFrames()
    const { panes, wc } = setup(frames)
    panes.handle(attach)
    wc.emit('paint', { texture: texture() })
    expect(frames.browserSend).not.toHaveBeenCalled()
  })

  it('stops painting on detach and on a reset, and disconnects on a reset', () => {
    const frames = fakeFrames()
    const { panes, wc } = setup(frames)
    panes.handle(rendezvous)
    panes.handle(attach)
    panes.handle({ type: 'browserDetach', pageId: 'page-1' })
    expect(wc.painting).toBe(false)
    panes.handle(attach)
    panes.reset()
    expect(wc.painting).toBe(false)
    expect(frames.browserDisconnect).toHaveBeenCalled()
    wc.emit('paint', { texture: texture() })
    expect(frames.browserSend).not.toHaveBeenCalled()
  })

  it('streams an attached pane only while it is on screen (browserPane)', () => {
    const frames = fakeFrames()
    const { panes, wc } = setup(frames)
    panes.handle(rendezvous)
    panes.handle(attach)
    panes.handle({ type: 'browserPane', pageId: 'page-1', visible: false })
    expect(wc.painting).toBe(false)
    wc.emit('paint', { texture: texture() })
    expect(frames.browserSend).not.toHaveBeenCalled()
    wc.invalidate.mockClear()
    panes.handle({ type: 'browserPane', pageId: 'page-1', visible: true })
    expect(wc.painting).toBe(true)
    expect(wc.invalidate).toHaveBeenCalledTimes(1)
    wc.emit('paint', { texture: texture() })
    expect(frames.browserSend).toHaveBeenCalledTimes(1)
    // The same visibility again changes nothing.
    panes.handle({ type: 'browserPane', pageId: 'page-1', visible: true })
    expect(wc.invalidate).toHaveBeenCalledTimes(1)
  })

  it('connects to a rendezvous a browserPane names, once per new name', () => {
    const frames = fakeFrames()
    const { panes } = setup(frames)
    panes.handle(attach)
    const pane = {
      type: 'browserPane',
      pageId: 'page-1',
      visible: true,
      rendezvous: rendezvous.service
    } as const
    panes.handle(pane)
    panes.handle(pane)
    expect(frames.browserConnect).toHaveBeenCalledTimes(1)
    expect(frames.browserConnect).toHaveBeenCalledWith(rendezvous.service)
  })

  it.each([
    ['a page it does not host', 'webview-page', 'no offscreen page with that id'],
    ['a page no pane is attached to', 'page-1', 'no pane is attached to that page']
  ])('refuses a browserPane for %s', (_name, pageId, reason) => {
    const { panes, wc, sent } = setup()
    panes.handle({ type: 'browserPane', pageId, visible: true })
    expect(sent).toContainEqual({ type: 'browserAttachFailed', pageId, reason })
    expect(wc.painting).toBe(false)
  })

  it('says why it cannot attach a page it does not host', () => {
    const { panes, sent } = setup()
    panes.handle({ ...attach, pageId: 'webview-page' })
    expect(sent).toContainEqual({
      type: 'browserAttachFailed',
      pageId: 'webview-page',
      reason: 'no offscreen page with that id'
    })
  })

  it('drives input, edit commands and navigation, and loads only http(s)', () => {
    const { panes, wc, devTools } = setup()
    panes.handle(attach)
    panes.handle({
      type: 'browserInput',
      pageId: 'page-1',
      event: {
        kind: 'mouse',
        action: 'down',
        x: 5,
        y: 6,
        button: 'left',
        clickCount: 1,
        modifiers: []
      }
    })
    panes.handle({
      type: 'browserInput',
      pageId: 'page-1',
      event: { kind: 'key', action: 'down', keyCode: 'c', modifiers: ['meta'] }
    })
    panes.handle({ type: 'browserInput', pageId: 'page-1', event: { kind: 'text', text: 'hej' } })
    expect(wc.inputs).toEqual([
      { type: 'mouseDown', x: 5, y: 6, button: 'left', clickCount: 1, modifiers: [] }
    ])
    expect(wc.calls).toContain('copy')
    expect(wc.insertText).toHaveBeenCalledWith('hej')

    wc.history.back = true
    panes.handle({ type: 'browserNavigate', pageId: 'page-1', action: 'back' })
    panes.handle({ type: 'browserNavigate', pageId: 'page-1', action: 'forward' })
    panes.handle({ type: 'browserNavigate', pageId: 'page-1', action: 'reload' })
    expect(wc.calls).toEqual(['copy', 'goBack', 'reload'])
    panes.handle({
      type: 'browserNavigate',
      pageId: 'page-1',
      action: 'load',
      url: 'javascript:alert(1)'
    })
    panes.handle({
      type: 'browserNavigate',
      pageId: 'page-1',
      action: 'load',
      url: 'https://pod.codes'
    })
    expect(wc.loadURL).toHaveBeenCalledTimes(1)
    expect(wc.loadURL).toHaveBeenCalledWith('https://pod.codes')

    panes.handle({
      type: 'browserFind',
      pageId: 'page-1',
      text: 'pod',
      forward: true,
      findNext: false
    })
    expect(wc.findInPage).toHaveBeenCalledWith('pod', { forward: true, findNext: false })
    panes.handle({ type: 'browserDevTools', pageId: 'page-1' })
    expect(devTools).toHaveBeenCalledWith(wc)
  })

  it('forwards cursor and find results of an attached page only', () => {
    const { panes, wc, sent } = setup()
    wc.emit('cursor-changed', {}, 'pointer')
    expect(sent).toEqual([])
    panes.handle(attach)
    wc.emit('cursor-changed', {}, 'text')
    wc.emit('found-in-page', {}, { matches: 3, activeMatchOrdinal: 1, finalUpdate: true })
    expect(sent).toContainEqual({ type: 'browserCursor', pageId: 'page-1', cursor: 'text' })
    expect(sent).toContainEqual({
      type: 'browserFound',
      pageId: 'page-1',
      matches: 3,
      active: 1,
      final: true
    })
  })

  it("shows an attached page's select menus, but none while an agent drives it", () => {
    const { panes, wc, sent } = setup()
    wc.emit('dom-ready')
    const code = String(wc.executeJavaScriptInIsolatedWorld.mock.calls[0]?.[1]?.[0]?.code ?? '')
    const nonce = /pod-select " \+ "([0-9a-f]{32})"/.exec(code)?.[1]
    const line = `\u0000pod-select ${nonce} ${JSON.stringify({ menuId: 1, x: 1, y: 2, width: 3, height: 4, items: [] })}`
    wc.emit('console-message', { message: line })
    expect(sent).toEqual([])
    panes.handle(attach)
    wc.emit('console-message', { message: line })
    expect(sent).toContainEqual({
      type: 'browserPopupMenu',
      pageId: 'page-1',
      menuId: 1,
      x: 1,
      y: 2,
      width: 3,
      height: 4,
      items: []
    })
    sent.length = 0
    panes.noteAgentCommand(wc.id)
    sent.length = 0
    wc.emit('console-message', { message: line })
    expect(sent).toEqual([])
    panes.handle({ type: 'browserPopupChoose', pageId: 'page-1', menuId: 1, index: 0 })
    expect(wc.executeJavaScriptInIsolatedWorld).toHaveBeenLastCalledWith(1987, [
      { code: 'globalThis.__podSelectChoose?.(1, 0)' }
    ])
  })

  it("lists its pages' downloads, and repeats them to a PodNative that connects", () => {
    const { panes, sent } = setup()
    panes.noteDownload({
      kind: 'requested',
      browserPageId: 'other',
      downloadId: 'x',
      filename: 'x',
      totalBytes: null,
      savePath: ''
    })
    panes.noteDownload({
      kind: 'requested',
      browserPageId: 'page-1',
      downloadId: 'd1',
      filename: 'a.zip',
      totalBytes: 10,
      savePath: '/tmp/a.zip'
    })
    expect(sent).toEqual([
      expect.objectContaining({ type: 'browserDownload', downloadId: 'd1', state: 'downloading' })
    ])
    sent.length = 0
    panes.handle(rendezvous)
    expect(sent).toEqual([expect.objectContaining({ type: 'browserDownload', downloadId: 'd1' })])
  })

  it("shows an agent's command as driving for three seconds", () => {
    vi.useFakeTimers()
    const { panes, wc, sent } = setup()
    panes.handle(attach)
    sent.length = 0
    panes.noteAgentCommand(wc.id)
    panes.noteAgentCommand(wc.id)
    expect(sent).toEqual([expect.objectContaining({ type: 'browserState', agentDriving: true })])
    vi.advanceTimersByTime(3_000)
    expect(sent.at(-1)).toEqual(expect.objectContaining({ agentDriving: false }))
    panes.noteAgentCommand(999)
    expect(sent).toHaveLength(2)
  })
})
