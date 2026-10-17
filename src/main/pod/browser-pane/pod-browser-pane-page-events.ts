// Fork-only (Pod): what an offscreen page's WebContents tells its pane: the page menu, the hovered
// link, the cursor, find results and each change of its state line.
import type { WebContents } from 'electron'
import type { PodBrowserPaneServerMessage } from './pod-browser-pane-protocol'
import { describePaneContextMenu } from './pod-browser-pane-context-menu'
import type { PaneLinks } from './pod-browser-pane-links'
import {
  encodePodUiHostServerMessage,
  POD_UI_HOST_MAX_LINE_BYTES
} from '../ui-host/pod-ui-host-protocol'

// Why capped: past POD_UI_HOST_MAX_LINE_BYTES PodNative drops the whole channel, and every state of
// the page would cut it again. Chromium's URLs are ASCII, so their length is their size.
const MAX_FAVICON_URL_LENGTH = 8192
// A longer page URL (a data: page) gets the whole state line measured; one that won't fit goes as ''.
const LONG_PAGE_URL_LENGTH = 16_384

/** The parts of a tracked page these read and write. */
export type PanePage = {
  wc: WebContents
  token: number | null
  links: PaneLinks
  agentDrivingUntil: number
  // The icon the current document declares; a new document starts without one.
  favicon: string | undefined
}

/** Follows the page's events for its pane; `state` sends its state line again. */
export function followPanePage(
  pageId: string,
  page: PanePage,
  hooks: {
    send: (message: PodBrowserPaneServerMessage) => boolean
    userDriven: () => boolean
    state: () => void
  }
): void {
  const { wc } = page
  // Why not while an agent drives: its right-clicks must not open a menu on the screen.
  wc.on('context-menu', (_event, params) => {
    if (hooks.userDriven()) {
      hooks.send(describePaneContextMenu(pageId, wc, params))
    }
  })
  // Why not while an agent drives: its pointer must not show links on the screen.
  wc.on('update-target-url', (_event, url) => page.links.hover(url, hooks.userDriven()))
  // Why: the link under the pointer was the old page's; the next page's hover starts afresh.
  wc.on('did-navigate', () => page.links.hover('', false))
  wc.on('did-navigate', () => {
    page.favicon = undefined
  })
  wc.on('page-favicon-updated', (_event, favicons) => {
    page.favicon = favicons.find((icon) => icon.length <= MAX_FAVICON_URL_LENGTH)
    hooks.state()
  })
  wc.on('cursor-changed', (_event, cursor) => {
    if (page.token !== null) {
      hooks.send({ type: 'browserCursor', pageId, cursor })
    }
  })
  wc.on('found-in-page', (_event, result) => {
    if (page.token !== null) {
      hooks.send({
        type: 'browserFound',
        pageId,
        matches: result.matches,
        active: result.activeMatchOrdinal,
        final: result.finalUpdate
      })
    }
  })
  wc.on('did-start-loading', hooks.state)
  wc.on('did-stop-loading', hooks.state)
  wc.on('did-navigate', hooks.state)
  wc.on('did-navigate-in-page', hooks.state)
  wc.on('page-title-updated', hooks.state)
}

/** The page's state line, its URL left out when the line wouldn't fit. */
export function panePageState(pageId: string, page: PanePage): PodBrowserPaneServerMessage {
  const { wc } = page
  const url = wc.getURL()
  const state = {
    type: 'browserState' as const,
    pageId,
    url,
    title: wc.getTitle(),
    loading: wc.isLoading(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    agentDriving: Date.now() < page.agentDrivingUntil,
    ...(page.favicon ? { faviconUrl: page.favicon } : {})
  }
  const fits =
    url.length <= LONG_PAGE_URL_LENGTH ||
    Buffer.byteLength(encodePodUiHostServerMessage(state)) <= POD_UI_HOST_MAX_LINE_BYTES
  return fits ? state : { ...state, url: '' }
}
