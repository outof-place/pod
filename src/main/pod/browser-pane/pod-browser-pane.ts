// Fork-only (Pod): one-app's browser panes. In one-app, browser pages are offscreen WebContents with
// shared textures (the offscreen backend, set up by installPodBrowserPanes); PodNative attaches a
// native pane to one, and while it is attached and on screen its frames go to PodNative as
// IOSurfaces over Mach, its state, cursor and find results over the control socket. A page nobody
// sees does not paint; agents still drive and capture it over CDP (a capture needs no painting).
import type { BrowserWindow, WebContents } from 'electron'
import type {
  PodBrowserPaneClientMessage,
  PodBrowserPaneServerMessage
} from './pod-browser-pane-protocol'
import { PaneDownloads } from './pod-browser-pane-downloads'
import type { PodBrowserDownloadEvent } from './pod-browser-pane-hooks'
import { PaneInputState } from './pod-browser-pane-input'
import { navigatePanePage } from './pod-browser-pane-navigation'
import { PaneSelectMenus } from './pod-browser-pane-select'
import { PaneLinks } from './pod-browser-pane-links'
import { PanePasskeys, type PanePasskeyAccount } from './pod-browser-pane-passkeys'
import {
  PaneFramePump,
  POD_BROWSER_PANE_DEFAULT_SCALE,
  type PodBrowserFrames
} from './pod-browser-pane-frames'
import { followPanePage, panePageState } from './pod-browser-pane-page-events'
import { applyPanePageInput } from './pod-browser-pane-page-input'
import { PaneZoom } from './pod-browser-pane-zoom'
const PANE_FRAME_RATE = 60
// A page nobody sees and no agent drives. Why 10: a rate change waits for the next tick, so a
// pane coming back (or an agent's screenshot) waits ≤100 ms; an animated page costs 13 ms/s here
// against 67 at 60 fps (1 fps: 1.7 ms/s but up to a second's wait). Measured on Electron 45.
const UNSEEN_FRAME_RATE = 10
// How long after an agent's last command its page still reads as driven.
const AGENT_DRIVING_MS = 3_000

type Page = {
  win: BrowserWindow
  wc: WebContents
  token: number | null
  // An attached pane off screen (browserPane visible false) keeps its token but doesn't paint.
  visible: boolean
  seq: number
  // The device scale it renders at: Electron fixes an offscreen page's when it opens.
  scale: number
  input: PaneInputState
  select: PaneSelectMenus
  links: PaneLinks
  agentDrivingUntil: number
  agentTimer: ReturnType<typeof setTimeout> | null
  // The icon the current document declares; a new document starts without one.
  favicon: string | undefined
  zoom: PaneZoom
}

export class PodBrowserPaneController {
  private readonly pages = new Map<string, Page>()
  private readonly downloads = new PaneDownloads()
  private readonly frames: PaneFramePump
  private readonly passkeys: PanePasskeys
  // The scale of the display PodNative last attached or resized a pane on.
  private reportedScale: number | null = null
  // The scale newPageScale last gave a window, which its trackPage records.
  private openingScale: number | null = null

  constructor(
    private readonly deps: {
      frames: PodBrowserFrames | null
      send: (message: PodBrowserPaneServerMessage) => boolean
      openDevTools: (wc: WebContents) => void
      log: (message: string) => void
      // The main display's scale: what a page opens at before any pane reported one.
      mainDisplayScale?: () => number
      // The browser manager's cancel for a download of a page no renderer hosts.
      cancelDownload?: (pageId: string, downloadId: string) => boolean
      // Pod's browserDefaultZoomLevel setting.
      defaultZoomLevel?: () => number | undefined
    }
  ) {
    this.frames = new PaneFramePump(deps.frames, deps.log)
    this.passkeys = new PanePasskeys(deps.send)
  }

  get stats(): PaneFramePump['stats'] {
    return this.frames.stats
  }

  /**
   * The device scale a page opening now renders at: that of the display PodNative last showed a
   * pane on, else the main display's. A page keeps it for life (Electron sets it only at creation);
   * PodNative draws each frame at the scale it carries, on any display.
   */
  newPageScale(): number {
    const scale =
      this.reportedScale ?? this.deps.mainDisplayScale?.() ?? POD_BROWSER_PANE_DEFAULT_SCALE
    this.openingScale = Number.isFinite(scale)
      ? Math.min(Math.max(scale, 1), 4)
      : POD_BROWSER_PANE_DEFAULT_SCALE
    return this.openingScale
  }

  /** An offscreen page the backend made: it waits, not painting, until a pane attaches. */
  trackPage(pageId: string, win: BrowserWindow): void {
    const wc = win.webContents
    const page: Page = {
      win,
      wc,
      token: null,
      visible: false,
      seq: 0,
      // What the backend just gave its window (a pane reporting another scale meanwhile changes
      // nothing for it).
      scale: this.openingScale ?? this.newPageScale(),
      input: new PaneInputState(),
      select: new PaneSelectMenus(wc, {
        pageId,
        viewSize: () => win.getContentSize(),
        // Why not while an agent drives: its clicks on a select must not open a menu on the screen.
        onMenu: (menu) => {
          if (this.userDriven(page)) {
            this.deps.send(menu)
          }
        }
      }),
      links: new PaneLinks(pageId, (message) => this.deps.send(message)),
      agentDrivingUntil: 0,
      agentTimer: null,
      favicon: undefined,
      zoom: new PaneZoom(wc, this.deps.defaultZoomLevel?.(), () => this.sendState(pageId))
    }
    this.openingScale = null
    this.pages.set(pageId, page)
    wc.stopPainting()
    wc.setFrameRate(UNSEEN_FRAME_RATE)
    wc.on('paint', (event) => this.frames.paint(page, event.texture))
    followPanePage(pageId, page, {
      send: this.deps.send,
      userDriven: () => this.userDriven(page),
      state: () => this.sendState(pageId)
    })
    wc.once('destroyed', () => {
      if (page.agentTimer) {
        clearTimeout(page.agentTimer)
      }
      if (this.pages.get(pageId) === page) {
        this.pages.delete(pageId)
      }
      this.passkeys.cancelPage(pageId)
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
        this.pace(page)
        this.sendState(pageId)
      }, AGENT_DRIVING_MS)
      page.agentTimer.unref?.()
      page.links.noteAgentCommand()
      if (!wasDriving) {
        this.pace(page)
        this.sendState(pageId)
      }
      return
    }
  }

  /** A download of one of these pages: PodNative's list follows it. */
  noteDownload(event: PodBrowserDownloadEvent): void {
    const record = this.pages.has(event.browserPageId) ? this.downloads.note(event) : null
    if (record) {
      this.deps.send(record)
    }
  }

  /** A new-tab open of one of these pages, which no renderer takes: PodNative's after the user's own click or key. */
  openLink(pageId: string, url: string, activate: boolean): boolean {
    const page = this.pages.get(pageId)
    return (
      page !== undefined &&
      !page.wc.isDestroyed() &&
      this.userDriven(page) &&
      page.links.open(url, activate)
    )
  }

  /** A security key's accounts for one of these pages: PodNative's pick, while the user drives it. */
  pickPasskey(
    webContentsId: number,
    relyingPartyId: string,
    accounts: readonly PanePasskeyAccount[]
  ): Promise<string | null> | null {
    for (const [pageId, page] of this.pages) {
      if (!page.wc.isDestroyed() && page.wc.id === webContentsId) {
        // Why not while an agent drives: nobody at the screen asked for it.
        return this.userDriven(page) ? this.passkeys.request(pageId, relyingPartyId, accounts) : null
      }
    }
    return null
  }

  handle(message: PodBrowserPaneClientMessage): void {
    if (message.type === 'browserRendezvous') {
      // A PodNative that just connected learns what downloaded meanwhile.
      this.downloads.all().forEach((record) => this.deps.send(record))
      this.frames.connect(message.service)
      return
    }
    const page = this.pages.get(message.pageId)
    if (!page || page.wc.isDestroyed()) {
      if (message.type === 'browserAttach' || message.type === 'browserPane') {
        // A page the classic window hosts (a <webview>), or one already gone.
        this.refuse(message.pageId, 'no offscreen page with that id')
      }
      return
    }
    const { wc } = page
    switch (message.type) {
      case 'browserAttach':
        const scaleNote =
          message.scale === page.scale
            ? ''
            : ` on a ${message.scale}x display; the page renders at ${page.scale}x`
        this.deps.log(
          `browser-pane: attach ${message.pageId} ${message.width}x${message.height}${scaleNote}`
        )
        this.reportedScale = message.scale
        // A newer attach of the same page replaces the older one.
        page.token = message.token
        page.input.reset()
        page.links.reset()
        this.resize(page, message.width, message.height)
        this.show(page, true)
        this.sendState(message.pageId)
        return
      case 'browserDetach':
        this.detach(page)
        return
      case 'browserPane':
        if (message.rendezvous && message.rendezvous !== this.frames.service) {
          this.frames.connect(message.rendezvous)
        }
        if (page.token === null) {
          this.refuse(message.pageId, 'no pane is attached to that page')
        } else if (page.visible !== message.visible) {
          this.show(page, message.visible)
        }
        return
      case 'browserResize':
        this.reportedScale = message.scale
        this.resize(page, message.width, message.height)
        return
      case 'browserInput':
        applyPanePageInput(page, message.event)
        return
      case 'browserNavigate':
        navigatePanePage(wc, message, this.deps.log)
        return
      case 'browserPopupChoose':
        page.select.choose(message.menuId, message.index)
        return
      case 'browserPasskeyChoose':
        this.passkeys.choose(message.pageId, message.requestId, message.credentialId)
        return
      case 'browserZoom':
        page.zoom.step(message.direction)
        return
      case 'browserDownloadCancel':
        if (!this.deps.cancelDownload?.(message.pageId, message.downloadId)) {
          this.deps.log(`browser-pane: no download ${message.downloadId} of ${message.pageId} to cancel`)
        }
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
    this.passkeys.cancelAll()
    this.frames.disconnect()
  }

  // Why: what an agent does to a page must not open menus or show links on the user's screen.
  private userDriven(page: Page): boolean {
    return page.token !== null && Date.now() >= page.agentDrivingUntil
  }

  private refuse(pageId: string, reason: string): void {
    this.deps.send({ type: 'browserAttachFailed', pageId, reason })
  }

  // Why: the only paint switch for offscreen pages; b4-perf's page sleep leaves them alone.
  private show(page: Page, visible: boolean): void {
    page.visible = visible
    if (page.wc.isDestroyed()) {
      return
    }
    this.pace(page)
    if (visible) {
      page.wc.startPainting()
      page.wc.invalidate()
    } else {
      page.wc.stopPainting()
    }
  }

  // Why an agent counts: rAF-polled waits (Playwright's default) would crawl at one frame a second.
  private pace(page: Page): void {
    const seen = (page.token !== null && page.visible) || Date.now() < page.agentDrivingUntil
    if (!page.wc.isDestroyed()) {
      page.wc.setFrameRate(seen ? PANE_FRAME_RATE : UNSEEN_FRAME_RATE)
    }
  }

  private detach(page: Page): void {
    page.token = null
    page.input.reset()
    page.links.reset()
    this.show(page, false)
  }

  private resize(page: Page, width: number, height: number): void {
    const [currentWidth, currentHeight] = page.win.getContentSize()
    if (currentWidth !== width || currentHeight !== height) {
      page.win.setContentSize(width, height)
    }
  }

  private sendState(pageId: string): void {
    const page = this.pages.get(pageId)
    if (page && page.token !== null && !page.wc.isDestroyed()) {
      this.deps.send(panePageState(pageId, page))
    }
  }
}
