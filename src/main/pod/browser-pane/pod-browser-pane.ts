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
import { describePaneContextMenu } from './pod-browser-pane-context-menu'
import { PaneLinks } from './pod-browser-pane-links'
import { PanePasskeys, type PanePasskeyAccount } from './pod-browser-pane-passkeys'
import { PaneFramePump, type PodBrowserFrames } from './pod-browser-pane-frames'
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
  input: PaneInputState
  select: PaneSelectMenus
  links: PaneLinks
  agentDrivingUntil: number
  agentTimer: ReturnType<typeof setTimeout> | null
  // The icon the current document declares; a new document starts without one.
  favicon: string | undefined
}

export class PodBrowserPaneController {
  private readonly pages = new Map<string, Page>()
  private readonly downloads = new PaneDownloads()
  private readonly frames: PaneFramePump
  private readonly passkeys: PanePasskeys

  constructor(
    private readonly deps: {
      frames: PodBrowserFrames | null
      send: (message: PodBrowserPaneServerMessage) => boolean
      openDevTools: (wc: WebContents) => void
      log: (message: string) => void
    }
  ) {
    this.frames = new PaneFramePump(deps.frames, deps.log)
    this.passkeys = new PanePasskeys(deps.send)
  }

  get stats(): PaneFramePump['stats'] {
    return this.frames.stats
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
      input: new PaneInputState(),
      // Why not while an agent drives: its clicks on a select must not open a menu on the screen.
      select: new PaneSelectMenus(wc, (menu) => {
        if (this.userDriven(page)) {
          this.deps.send({ type: 'browserPopupMenu', pageId, ...menu })
        }
      }),
      links: new PaneLinks(pageId, (message) => this.deps.send(message)),
      agentDrivingUntil: 0,
      agentTimer: null,
      favicon: undefined
    }
    this.pages.set(pageId, page)
    wc.stopPainting()
    wc.setFrameRate(UNSEEN_FRAME_RATE)
    wc.on('paint', (event) => this.frames.paint(page, event.texture))
    // Why not while an agent drives: its right-clicks must not open a menu on the screen.
    wc.on('context-menu', (_event, params) => {
      if (this.userDriven(page)) {
        this.deps.send(describePaneContextMenu(pageId, wc, params))
      }
    })
    // Why not while an agent drives: its pointer must not show links on the screen.
    wc.on('update-target-url', (_event, url) => page.links.hover(url, this.userDriven(page)))
    // Why: the link under the pointer was the old page's; the next page's hover starts afresh.
    wc.on('did-navigate', () => page.links.hover('', false))
    wc.on('did-navigate', () => {
      page.favicon = undefined
    })
    wc.on('page-favicon-updated', (_event, favicons) => {
      page.favicon = favicons[0]
      this.sendState(pageId)
    })
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
    wc.on('did-start-loading', state)
    wc.on('did-stop-loading', state)
    wc.on('did-navigate', state)
    wc.on('did-navigate-in-page', state)
    wc.on('page-title-updated', state)
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
        this.deps.log(`browser-pane: attach ${message.pageId} ${message.width}x${message.height}`)
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
        this.resize(page, message.width, message.height)
        return
      case 'browserInput': {
        page.links.noteInput(message.event)
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
      case 'browserPasskeyChoose':
        this.passkeys.choose(message.pageId, message.requestId, message.credentialId)
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
      agentDriving: Date.now() < page.agentDrivingUntil,
      ...(page.favicon ? { faviconUrl: page.favicon } : {})
    })
  }
}
