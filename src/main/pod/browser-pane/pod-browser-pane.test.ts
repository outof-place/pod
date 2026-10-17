import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PodBrowserPaneController } from './pod-browser-pane'
import type { PodBrowserFrames } from './pod-browser-pane-frames'
import type { PodBrowserPaneServerMessage } from './pod-browser-pane-protocol'
import { POD_UI_HOST_MAX_LINE_BYTES } from '../ui-host/pod-ui-host-protocol'

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

function setup(frames: PodBrowserFrames | null = fakeFrames(), mainDisplayScale?: () => number) {
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
      agentDriving: false,
      zoomPercent: 100
    })
  })

  it("zooms the page a step at a time, says so in its state, and hard-reloads it", () => {
    const { panes, wc, sent } = setup()
    panes.handle(rendezvous)
    panes.handle(attach)
    panes.handle({ type: 'browserZoom', pageId: 'page-1', direction: 'in' })
    expect(wc.zoomLevel).toBe(0.5)
    expect(sent.at(-1)).toMatchObject({ type: 'browserState', zoomPercent: 110 })
    panes.handle({ type: 'browserZoom', pageId: 'page-1', direction: 'out' })
    panes.handle({ type: 'browserZoom', pageId: 'page-1', direction: 'out' })
    expect(sent.at(-1)).toMatchObject({ zoomPercent: 91 })
    panes.handle({ type: 'browserZoom', pageId: 'page-1', direction: 'reset' })
    expect(wc.zoomLevel).toBe(0)
    panes.handle({ type: 'browserNavigate', pageId: 'page-1', action: 'reloadHard' })
    expect(wc.calls).toContain('reloadIgnoringCache')
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

  it("opens a page at the main display's scale until a pane reports one", () => {
    const frames = fakeFrames()
    const { panes, wc } = setup(frames, () => 1)
    panes.handle(rendezvous)
    panes.handle({ ...attach, scale: 1 })
    wc.emit('paint', { texture: texture() })
    expect(frames.browserSend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scaleX100: 100 })
    )
  })

  it('opens the next page at the scale a pane last reported; an open page keeps its own', () => {
    const frames = fakeFrames()
    const { panes, wc } = setup(frames, () => 2)
    panes.handle(rendezvous)
    panes.handle({ ...attach, scale: 1 })
    wc.emit('paint', { texture: texture() })
    expect(frames.browserSend).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ scaleX100: 200 })
    )
    expect(panes.newPageScale()).toBe(1)

    const second = new FakeWebContents()
    second.id = 42
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fakes implement every member the controller calls.
    panes.trackPage('page-2', new FakeWindow(second) as unknown as Electron.BrowserWindow)
    panes.handle({ ...attach, pageId: 'page-2', token: 8, scale: 1 })
    second.emit('paint', { texture: texture() })
    expect(frames.browserSend).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ token: 8, scaleX100: 100 })
    )

    panes.handle({ type: 'browserResize', pageId: 'page-2', width: 900, height: 700, scale: 2 })
    expect(panes.newPageScale()).toBe(2)
  })

  it('gives a page the scale its window opened at, though a pane reports another before it is tracked', () => {
    const frames = fakeFrames()
    const { panes } = setup(frames, () => 1)
    // The backend's webPreferences for page-2's window.
    expect(panes.newPageScale()).toBe(1)
    panes.handle(rendezvous)
    panes.handle({ ...attach, scale: 2 })
    const second = new FakeWebContents()
    second.id = 42
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fakes implement every member the controller calls.
    panes.trackPage('page-2', new FakeWindow(second) as unknown as Electron.BrowserWindow)
    panes.handle({ ...attach, pageId: 'page-2', token: 8, scale: 2 })
    second.emit('paint', { texture: texture() })
    expect(frames.browserSend).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ token: 8, scaleX100: 100 })
    )
  })

  it("keeps a new page's scale between 1 and 4, and Retina when the display says nothing usable", () => {
    expect(setup(fakeFrames(), () => Number.NaN).panes.newPageScale()).toBe(2)
    expect(setup(fakeFrames(), () => 0.5).panes.newPageScale()).toBe(1)
    expect(setup(fakeFrames(), () => 8).panes.newPageScale()).toBe(4)
    expect(setup(fakeFrames()).panes.newPageScale()).toBe(2)
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

  it("sends the page's declared icon and drops it when a new document loads", () => {
    const { panes, wc, sent } = setup()
    panes.handle(attach)
    wc.emit('page-favicon-updated', {}, [
      'https://example.com/icon-32.png',
      'https://example.com/icon-16.png'
    ])
    expect(sent.at(-1)).toMatchObject({
      type: 'browserState',
      faviconUrl: 'https://example.com/icon-32.png'
    })
    wc.emit('did-navigate')
    expect(sent.at(-1)).toMatchObject({ type: 'browserState' })
    expect(sent.at(-1)).not.toHaveProperty('faviconUrl')
  })

  it('never sends an icon URL that would cut the channel: a 70 KB data: icon falls to the next one', () => {
    const { panes, wc, sent } = setup()
    panes.handle(attach)
    const huge = `data:image/png;base64,${'A'.repeat(70 * 1024)}`
    wc.emit('page-favicon-updated', {}, [huge])
    expect(sent.at(-1)).toMatchObject({ type: 'browserState' })
    expect(sent.at(-1)).not.toHaveProperty('faviconUrl')
    wc.emit('page-favicon-updated', {}, [huge, 'https://example.com/icon-16.png'])
    expect(sent.at(-1)).toMatchObject({ faviconUrl: 'https://example.com/icon-16.png' })
  })

  it("keeps a state line within the channel's limit on a 100 KB data: page", () => {
    const { panes, wc, sent } = setup()
    panes.handle(attach)
    wc.url = `data:text/html;base64,${'P'.repeat(100 * 1024)}`
    wc.emit('did-navigate')
    const state = sent.at(-1)
    expect(state).toMatchObject({ type: 'browserState', url: '' })
    expect(Buffer.byteLength(`${JSON.stringify(state)}\n`)).toBeLessThanOrEqual(
      POD_UI_HOST_MAX_LINE_BYTES
    )
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
      menuId: 2,
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

  it("shows an iframe's select menu only after the user's own click", () => {
    const { panes, wc, sent } = setup()
    panes.handle(attach)
    const frame = Object.assign(new EventEmitter(), {
      parent: {},
      detached: false,
      isDestroyed: () => false,
      executeJavaScript: vi.fn(async (_code: string) => {})
    })
    wc.emit('frame-created', {}, { frame })
    frame.emit('dom-ready')
    const doc = /const doc = "([0-9a-f]{16})"/.exec(String(frame.executeJavaScript.mock.calls[0]?.[0]))?.[1]
    const message = `\u0000pod-select-frame ${JSON.stringify({ doc, menuId: 1, clientX: 5, clientY: 6, x: 0, y: 0, width: 50, height: 20, items: [] })}`
    sent.length = 0
    wc.emit('console-message', { message, frame })
    expect(sent).toEqual([])
    const down = (button: 'left' | 'right') => ({
      type: 'browserInput' as const,
      pageId: 'page-1',
      event: { kind: 'mouse' as const, action: 'down' as const, x: 5, y: 6, button, clickCount: 1, modifiers: [] }
    })
    panes.handle(down('right'))
    wc.emit('console-message', { message, frame })
    expect(sent).toEqual([])
    panes.handle(down('left'))
    wc.emit('console-message', { message, frame })
    expect(sent).toEqual([expect.objectContaining({ type: 'browserPopupMenu', x: 0, y: 0, width: 50 })])
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

  it("cancels its pages' downloads through the browser manager, and logs a miss", () => {
    const cancelDownload = vi.fn((pageId: string) => pageId === 'page-1')
    const log = vi.fn()
    const panes = new PodBrowserPaneController({
      frames: fakeFrames(),
      send: () => true,
      openDevTools: vi.fn(),
      log,
      cancelDownload
    })
    const win = new FakeWindow(new FakeWebContents())
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fakes implement every member the controller calls.
    panes.trackPage('page-1', win as unknown as Electron.BrowserWindow)
    panes.handle({ type: 'browserDownloadCancel', pageId: 'page-1', downloadId: 'd1' })
    expect(cancelDownload).toHaveBeenCalledWith('page-1', 'd1')
    expect(log).not.toHaveBeenCalled()
    // A page this controller never tracked reaches nothing.
    panes.handle({ type: 'browserDownloadCancel', pageId: 'other', downloadId: 'd2' })
    expect(cancelDownload).toHaveBeenCalledTimes(1)
    cancelDownload.mockReturnValue(false)
    panes.handle({ type: 'browserDownloadCancel', pageId: 'page-1', downloadId: 'gone' })
    expect(log).toHaveBeenCalledWith('browser-pane: no download gone of page-1 to cancel')
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

  it("asks PodNative for a key's account only for an attached page the user drives", async () => {
    const { panes, wc, sent } = setup()
    const accounts = [{ credentialId: 'credential-1' }, { credentialId: 'credential-2' }]
    expect(panes.pickPasskey(wc.id, 'example.com', accounts)).toBeNull()
    panes.handle(attach)
    expect(panes.pickPasskey(99, 'example.com', accounts)).toBeNull()
    const pick = panes.pickPasskey(wc.id, 'example.com', accounts)
    const request = sent.findLast((message) => message.type === 'browserPasskeyAccounts')
    expect(request).toMatchObject({ pageId: 'page-1', relyingPartyId: 'example.com', accounts })
    panes.handle({
      type: 'browserPasskeyChoose',
      pageId: 'page-1',
      requestId: request?.type === 'browserPasskeyAccounts' ? request.requestId : '',
      credentialId: 'credential-2'
    })
    await expect(pick).resolves.toBe('credential-2')

    panes.noteAgentCommand(wc.id)
    expect(panes.pickPasskey(wc.id, 'example.com', accounts)).toBeNull()
  })

  it("ends a page's open key request when the page goes and when PodNative does", async () => {
    const { panes, wc, sent } = setup()
    const accounts = [{ credentialId: 'credential-1' }]
    panes.handle(attach)
    const reset = panes.pickPasskey(wc.id, 'example.com', accounts)
    panes.reset()
    await expect(reset).resolves.toBeNull()
    panes.handle(attach)
    const destroyed = panes.pickPasskey(wc.id, 'example.com', accounts)
    wc.emit('destroyed')
    await expect(destroyed).resolves.toBeNull()
    expect(sent.filter((message) => message.type === 'browserPasskeyClosed')).toHaveLength(2)
  })

  it('ticks a page nobody sees at 10 fps, and at 60 while it shows or an agent drives it', () => {
    vi.useFakeTimers()
    const { panes, wc } = setup()
    const rate = (): unknown => wc.setFrameRate.mock.calls.at(-1)?.[0]
    expect(rate()).toBe(10)
    panes.noteAgentCommand(wc.id)
    expect(rate()).toBe(60)
    vi.advanceTimersByTime(3_000)
    expect(rate()).toBe(10)
    panes.handle(attach)
    expect(rate()).toBe(60)
    panes.handle({ type: 'browserPane', pageId: 'page-1', visible: false })
    expect(rate()).toBe(10)
    panes.handle({ type: 'browserPane', pageId: 'page-1', visible: true })
    expect(rate()).toBe(60)
    panes.handle({ type: 'browserDetach', pageId: 'page-1' })
    expect(rate()).toBe(10)
  })

  it("sends an attached page's right-click as Pod's renderer gets it: link normalized, URL redacted", () => {
    const { panes, wc, sent } = setup()
    wc.emit('context-menu', {}, { x: 5, y: 6, linkURL: 'https://example.com/a', selectionText: '' })
    expect(sent).toEqual([])
    panes.handle(attach)
    sent.length = 0
    wc.url = 'https://kagi.com/search?q=pod&token=secret'
    wc.history = { back: true, forward: false }
    wc.emit(
      'context-menu',
      {},
      { x: 5, y: 6, linkURL: 'example.com/docs', selectionText: 'some words' }
    )
    expect(sent).toEqual([
      {
        type: 'browserContextMenu',
        pageId: 'page-1',
        x: 5,
        y: 6,
        pageUrl: 'https://kagi.com/search?q=pod',
        linkUrl: 'https://example.com/docs',
        selectionText: 'some words',
        selectionComplete: true,
        canGoBack: true,
        canGoForward: false
      }
    ])
    sent.length = 0
    // Not on a link, or on one too long to open: no link.
    wc.emit('context-menu', {}, { x: 1, y: 1, linkURL: '', selectionText: '' })
    wc.emit(
      'context-menu',
      {},
      { x: 1, y: 1, linkURL: `data:text/plain,${'a'.repeat(9000)}`, selectionText: '' }
    )
    expect(sent.map((message) => 'linkUrl' in message && message.linkUrl)).toEqual([null, null])
    // An agent's right-click opens nothing on the screen.
    panes.noteAgentCommand(wc.id)
    sent.length = 0
    wc.emit('context-menu', {}, { x: 1, y: 1, linkURL: '', selectionText: '' })
    expect(sent).toEqual([])
  })

  it('cuts a selection too big for one line, never through a surrogate pair', () => {
    const { panes, wc, sent } = setup()
    panes.handle(attach)
    sent.length = 0
    const selection = `${'x'.repeat(40_000)}${'😀'.repeat(20_000)}`
    wc.emit('context-menu', {}, { x: 1, y: 1, linkURL: '', selectionText: selection })
    const [menu] = sent
    expect(menu).toMatchObject({ type: 'browserContextMenu', selectionComplete: false })
    const text = menu.type === 'browserContextMenu' ? menu.selectionText : ''
    expect(selection.startsWith(text)).toBe(true)
    // As much as fits: into the emoji, not halved.
    expect(text.length).toBeGreaterThan(40_000)
    expect(/[\ud800-\udbff]$/.test(text)).toBe(false)
    expect(Buffer.byteLength(`${JSON.stringify(menu)}\n`)).toBeLessThanOrEqual(
      POD_UI_HOST_MAX_LINE_BYTES
    )
  })

  it('fits the whole line: a 60 KiB selection beside 8 KiB page and link URLs', () => {
    const { panes, wc, sent } = setup()
    panes.handle(attach)
    sent.length = 0
    wc.url = `https://example.com/${'p'.repeat(8100)}`
    const link = `https://example.com/${'l'.repeat(8100)}`
    wc.emit('context-menu', {}, { x: 1, y: 1, linkURL: link, selectionText: 'x'.repeat(60 * 1024) })
    const [menu] = sent
    expect(menu).toMatchObject({ pageUrl: wc.url, linkUrl: link, selectionComplete: false })
    expect(Buffer.byteLength(`${JSON.stringify(menu)}\n`)).toBeLessThanOrEqual(
      POD_UI_HOST_MAX_LINE_BYTES
    )
  })

  it("sends an attached page's hovered link for the status bubble, and none while an agent drives", () => {
    const { panes, wc, sent } = setup()
    wc.emit('update-target-url', {}, 'https://example.com/a')
    expect(sent).toEqual([])
    panes.handle(attach)
    sent.length = 0
    wc.emit('update-target-url', {}, 'https://kagi.com/search?q=pod&token=secret')
    wc.emit('update-target-url', {}, '')
    expect(sent).toEqual([
      {
        type: 'browserTargetUrl',
        pageId: 'page-1',
        url: 'https://kagi.com/search?q=pod'
      },
      { type: 'browserTargetUrl', pageId: 'page-1', url: '' }
    ])
    // A navigation ends the hover; the same link on the next page shows again.
    wc.emit('update-target-url', {}, 'https://example.com/a')
    wc.emit('did-navigate')
    wc.emit('update-target-url', {}, 'https://example.com/a')
    expect(sent.filter((message) => message.type === 'browserTargetUrl').slice(-3)).toEqual([
      { type: 'browserTargetUrl', pageId: 'page-1', url: 'https://example.com/a' },
      { type: 'browserTargetUrl', pageId: 'page-1', url: '' },
      { type: 'browserTargetUrl', pageId: 'page-1', url: 'https://example.com/a' }
    ])
    sent.length = 0
    // An agent starts: the bubble goes, and its own hovers show nothing.
    panes.noteAgentCommand(wc.id)
    wc.emit('update-target-url', {}, 'https://example.com/b')
    expect(sent.filter((message) => message.type === 'browserTargetUrl')).toEqual([
      { type: 'browserTargetUrl', pageId: 'page-1', url: '' }
    ])
  })

  it("opens a page's new-tab link the way the user's click asked: ⌘ the default browser, else a tab", () => {
    const { panes, wc, sent } = setup()
    const metaClick = (['down', 'up'] as const).map((action) => ({
      type: 'browserInput' as const,
      pageId: 'page-1',
      event: {
        kind: 'mouse' as const,
        action,
        x: 5,
        y: 6,
        button: 'left' as const,
        clickCount: 1,
        modifiers: ['meta' as const]
      }
    }))
    // No pane: nothing to open it in.
    expect(panes.openLink('page-1', 'https://example.com/a', false)).toBe(false)
    panes.handle(attach)
    sent.length = 0
    metaClick.forEach((message) => panes.handle(message))
    expect(panes.openLink('page-1', 'https://example.com/a', false)).toBe(true)
    // One click, one open.
    expect(panes.openLink('page-1', 'https://example.com/b', true)).toBe(false)
    panes.handle({ ...metaClick[0], event: { ...metaClick[0].event, modifiers: [] } })
    expect(panes.openLink('page-1', 'https://example.com/b', true)).toBe(true)
    expect(panes.openLink('other-page', 'https://example.com/c', true)).toBe(false)
    expect(sent).toEqual([
      {
        type: 'browserOpenLink',
        pageId: 'page-1',
        url: 'https://example.com/a',
        target: 'defaultBrowser'
      },
      {
        type: 'browserOpenLink',
        pageId: 'page-1',
        url: 'https://example.com/b',
        target: 'foregroundTab'
      }
    ])
    // An agent's clicks open nothing on the screen.
    panes.noteAgentCommand(wc.id)
    expect(panes.openLink('page-1', 'https://example.com/a', true)).toBe(false)
  })

  it("opens nothing from an agent's input, nor from the user's click before the agent took over", () => {
    vi.useFakeTimers()
    const { panes, wc, sent } = setup()
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
    // CDP input reaches the page as its own input events.
    panes.noteAgentCommand(wc.id)
    wc.emit('input-event', {}, { type: 'mouseDown' })
    wc.emit('input-event', {}, { type: 'mouseUp' })
    vi.advanceTimersByTime(3_000)
    sent.length = 0
    expect(panes.openLink('page-1', 'https://example.com/a', true)).toBe(false)
    expect(sent).toEqual([])
  })

  it('measures a link after normalizing it and sends lone surrogates as U+FFFD', () => {
    const { panes, wc, sent } = setup()
    panes.handle(attach)
    sent.length = 0
    // 1,020 characters, 9,020 once percent-encoded: past the bound.
    wc.emit(
      'context-menu',
      {},
      { x: 1, y: 1, linkURL: `https://example.com/${'…'.repeat(1000)}`, selectionText: 'a\ud800b' }
    )
    expect(sent).toMatchObject([
      { linkUrl: null, selectionText: 'a\ufffdb', selectionComplete: true }
    ])
  })
})
