// Fork-only (Pod): one-app's browser panes. In one-app, browser pages are offscreen WebContents with
// shared textures (the offscreen backend, set up by installPodBrowserPanes); PodNative attaches a
// native pane to one, and while it is attached its frames go to PodNative as IOSurfaces over Mach
// and its state, cursor and find results over the control socket. A page nobody shows does not
// paint; agents still drive and capture it over CDP.
import type { BrowserWindow, WebContents } from 'electron'
import type {
  PodBrowserPaneClientMessage,
  PodBrowserPaneServerMessage
} from './pod-browser-pane-protocol'
import { PaneInputState } from './pod-browser-pane-input'
import { navigatePanePage } from './pod-browser-pane-navigation'
import { PaneSelectMenus } from './pod-browser-pane-select'

// The device scale offscreen pages render at: Retina pixels on every Mac display Pod targets.
export const POD_BROWSER_PANE_SCALE = 2
const PANE_FRAME_RATE = 60
// How long after an agent's last command its page still reads as driven.
const AGENT_DRIVING_MS = 3_000

export type PodBrowserFrames = {
  browserConnect: (service: string) => boolean
  browserDisconnect: () => boolean
  browserSend: (
    ioSurface: Buffer,
    frame: {
      seq: number
      token: number
      widget: number
      popupX: number
      popupY: number
      scaleX100: number
    }
  ) => { ok: boolean; ns: number }
}

type Page = {
  win: BrowserWindow
  wc: WebContents
  token: number | null
  seq: number
  input: PaneInputState
  select: PaneSelectMenus
  agentDrivingUntil: number
  agentTimer: ReturnType<typeof setTimeout> | null
}

export type PodBrowserPaneStats = { framesSent: number; sendFailures: number; sendNs: number }

export class PodBrowserPaneController {
  private readonly pages = new Map<string, Page>()
  private connected = false
  // Attached paints in a row with no shared texture: Ganesh (disable-skia-graphite) turns them off.
  private texturelessPaints = 0
  readonly stats: PodBrowserPaneStats = { framesSent: 0, sendFailures: 0, sendNs: 0 }

  constructor(
    private readonly deps: {
      frames: PodBrowserFrames | null
      send: (message: PodBrowserPaneServerMessage) => boolean
      openDevTools: (wc: WebContents) => void
      log: (message: string) => void
    }
  ) {}

  /** An offscreen page the backend made: it waits, not painting, until a pane attaches. */
  trackPage(pageId: string, win: BrowserWindow): void {
    const wc = win.webContents
    const page: Page = {
      win,
      wc,
      token: null,
      seq: 0,
      input: new PaneInputState(),
      // Why not while an agent drives: its clicks on a select must not open a menu on the screen.
      select: new PaneSelectMenus(wc, (menu) => {
        if (page.token !== null && Date.now() >= page.agentDrivingUntil) {
          this.deps.send({ type: 'browserPopupMenu', pageId, ...menu })
        }
      }),
      agentDrivingUntil: 0,
      agentTimer: null
    }
    this.pages.set(pageId, page)
    wc.stopPainting()
    wc.on('paint', (event) => this.paint(page, event.texture))
    wc.on('cursor-changed', (_event, cursor) => {
      if (page.token !== null) {
        this.deps.send({ type: 'browserCursor', pageId, cursor })
      }
    })
    wc.on('found-in-page', (_event, result) => {
      if (page.token !== null) {
        this.deps.send({
          type: 'browserFound',
          pageId,
          matches: result.matches,
          active: result.activeMatchOrdinal,
          final: result.finalUpdate
        })
      }
    })
    const state = (): void => this.sendState(pageId)
    for (const event of [
      'did-start-loading',
      'did-stop-loading',
      'did-navigate',
      'did-navigate-in-page',
      'page-title-updated'
    ] as const) {
      wc.on(event as 'did-start-loading', state)
    }
    wc.once('destroyed', () => {
      if (page.agentTimer) {
        clearTimeout(page.agentTimer)
      }
      if (this.pages.get(pageId) === page) {
        this.pages.delete(pageId)
      }
    })
  }

  /** An agent command reached this WebContents: its pane shows the "agent is driving" badge. */
  noteAgentCommand(webContentsId: number): void {
    for (const [pageId, page] of this.pages) {
      if (page.wc.isDestroyed() || page.wc.id !== webContentsId) {
        continue
      }
      const wasDriving = Date.now() < page.agentDrivingUntil
      page.agentDrivingUntil = Date.now() + AGENT_DRIVING_MS
      if (page.agentTimer) {
        clearTimeout(page.agentTimer)
      }
      page.agentTimer = setTimeout(() => {
        page.agentTimer = null
        this.sendState(pageId)
      }, AGENT_DRIVING_MS)
      page.agentTimer.unref?.()
      if (!wasDriving) {
        this.sendState(pageId)
      }
      return
    }
  }

  handle(message: PodBrowserPaneClientMessage): void {
    if (message.type === 'browserRendezvous') {
      this.connected = this.deps.frames?.browserConnect(message.service) ?? false
      this.deps.log(
        this.connected
          ? 'browser-pane: frames go to PodNative'
          : 'browser-pane: PodNative has no frame receiver under that name'
      )
      return
    }
    const page = this.pages.get(message.pageId)
    if (!page || page.wc.isDestroyed()) {
      if (message.type === 'browserAttach') {
        // A page the classic window hosts (a <webview>), or one already gone.
        this.deps.send({
          type: 'browserAttachFailed',
          pageId: message.pageId,
          reason: 'no offscreen page with that id'
        })
      }
      return
    }
    const { wc } = page
    switch (message.type) {
      case 'browserAttach':
        this.deps.log(`browser-pane: attach ${message.pageId} ${message.width}x${message.height}`)
        // A newer attach of the same page replaces the older one.
        page.token = message.token
        page.input.reset()
        this.resize(page, message.width, message.height)
        wc.setFrameRate(PANE_FRAME_RATE)
        wc.startPainting()
        wc.invalidate()
        this.sendState(message.pageId)
        return
      case 'browserDetach':
        this.detach(page)
        return
      case 'browserResize':
        this.resize(page, message.width, message.height)
        return
      case 'browserInput': {
        const action = page.input.map(message.event)
        if (action.kind === 'send') {
          wc.sendInputEvent(action.input)
        } else if (action.kind === 'insertText') {
          void wc.insertText(action.text)
        } else if (action.kind === 'edit') {
          wc[action.command]()
        }
        return
      }
      case 'browserNavigate':
        navigatePanePage(wc, message, this.deps.log)
        return
      case 'browserPopupChoose':
        page.select.choose(message.menuId, message.index)
        return
      case 'browserFind':
        wc.findInPage(message.text, { forward: message.forward, findNext: message.findNext })
        return
      case 'browserFindStop':
        wc.stopFindInPage('clearSelection')
        return
      case 'browserFocus':
        if (message.focused) {
          wc.focus()
        }
        return
      case 'browserDevTools':
        this.deps.openDevTools(wc)
    }
  }

  /** PodNative went away or was replaced: nothing stays attached or connected. */
  reset(): void {
    for (const page of this.pages.values()) {
      this.detach(page)
    }
    this.deps.frames?.browserDisconnect()
    this.connected = false
  }

  private detach(page: Page): void {
    page.token = null
    page.input.reset()
    if (!page.wc.isDestroyed()) {
      page.wc.stopPainting()
    }
  }

  private resize(page: Page, width: number, height: number): void {
    const [currentWidth, currentHeight] = page.win.getContentSize()
    if (currentWidth !== width || currentHeight !== height) {
      page.win.setContentSize(width, height)
    }
  }

  private sendState(pageId: string): void {
    const page = this.pages.get(pageId)
    if (!page || page.token === null || page.wc.isDestroyed()) {
      return
    }
    const { wc } = page
    this.deps.send({
      type: 'browserState',
      pageId,
      url: wc.getURL(),
      title: wc.getTitle(),
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      agentDriving: Date.now() < page.agentDrivingUntil
    })
  }

  private paint(page: Page, texture: Electron.OffscreenSharedTexture | undefined): void {
    if (!texture) {
      if (page.token !== null && ++this.texturelessPaints === 30) {
        this.deps.log('browser-pane: paints come without shared textures; the pane stays blank')
      }
      return
    }
    this.texturelessPaints = 0
    try {
      const frames = this.deps.frames
      if (page.token === null || !this.connected || !frames) {
        return
      }
      const info = texture.textureInfo
      const ioSurface = info.handle.ioSurface
      if (!ioSurface) {
        return
      }
      page.seq += 1
      const result = frames.browserSend(ioSurface, {
        seq: page.seq,
        token: page.token,
        widget: info.widgetType === 'popup' ? 1 : 0,
        popupX: Math.round(info.contentRect?.x ?? 0),
        popupY: Math.round(info.contentRect?.y ?? 0),
        scaleX100: POD_BROWSER_PANE_SCALE * 100
      })
      this.stats.sendNs += result.ns
      if (result.ok) {
        this.stats.framesSent += 1
        if (this.stats.framesSent === 1) {
          this.deps.log('browser-pane: first frame sent')
        }
      } else {
        this.stats.sendFailures += 1
        if (this.stats.sendFailures === 1) {
          this.deps.log('browser-pane: a frame could not be sent')
        }
      }
    } finally {
      // Why at once: Chromium's pool is two surfaces; PodNative maps its own reference.
      texture.release()
    }
  }
}
