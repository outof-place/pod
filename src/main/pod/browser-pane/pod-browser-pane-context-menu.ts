// Fork-only (Pod): an offscreen page has no renderer for browser-guest-context-menu.ts, so its
// right-click goes to PodNative (browserContextMenu, a welcome feature) with the same fields, built the same way.
import {
  normalizeBrowserNavigationUrl,
  normalizeExternalBrowserUrl,
  redactKagiSessionToken
} from '../../../shared/browser-url'
import { readGuestNavigationState } from '../../browser/browser-guest-navigation-state'
import {
  encodePodUiHostServerMessage,
  POD_UI_HOST_MAX_LINE_BYTES
} from '../ui-host/pod-ui-host-protocol'
import type { PodBrowserPaneServerMessage } from './pod-browser-pane-protocol'

export type PodBrowserContextMenu = Extract<
  PodBrowserPaneServerMessage,
  { type: 'browserContextMenu' }
>

// browserNavigate's URL bound: a longer URL (data:) couldn't be opened from the menu anyway.
const MAX_URL_LENGTH = 8192

export function describePaneContextMenu(
  pageId: string,
  wc: Electron.WebContents,
  params: Pick<Electron.ContextMenuParams, 'x' | 'y' | 'linkURL' | 'selectionText'>
): PodBrowserContextMenu {
  // Why: redacted before it leaves main; PodNative copies it and opens it in the default browser.
  const pageUrl = redactKagiSessionToken(wc.getURL())
  const menu: PodBrowserContextMenu = {
    type: 'browserContextMenu',
    pageId,
    x: params.x,
    y: params.y,
    pageUrl: pageUrl.length <= MAX_URL_LENGTH ? pageUrl : '',
    linkUrl: describePaneLink(params.linkURL || ''),
    selectionText: '',
    selectionComplete: true,
    ...readGuestNavigationState(wc)
  }
  return fitSelection(menu, params.selectionText ?? '')
}

/** A link as Pod's renderer menu takes it: normalized (http, https or file), within the URL bound. */
export function describePaneLink(raw: string): string | null {
  // Why: an empty linkURL normalizes to the blank page, an "Open Link…" on every right-click.
  if (raw.length === 0 || raw.length > MAX_URL_LENGTH) {
    return null
  }
  const link = normalizeExternalBrowserUrl(raw) ?? normalizeBrowserNavigationUrl(raw)
  // Why measured again: percent-encoding grows a non-ASCII character up to nine times.
  return link !== null && link.length <= MAX_URL_LENGTH ? link : null
}

// Why the selection itself: Copy works on pages that block copy. A cut one PodNative copies with
// the page's own Copy instead. Why the whole line: past POD_UI_HOST_MAX_LINE_BYTES PodNative drops
// the channel, not just the menu.
function fitSelection(menu: PodBrowserContextMenu, raw: string): PodBrowserContextMenu {
  const fits = (text: string, complete: boolean): boolean =>
    Buffer.byteLength(
      encodePodUiHostServerMessage({ ...menu, selectionText: text, selectionComplete: complete })
    ) <= POD_UI_HOST_MAX_LINE_BYTES
  // Why: a lone surrogate encodes as \udXXX, which PodNative's JSONSerialization refuses. Each UTF-16
  // unit takes a byte at least, so a longer prefix never fits.
  const text = raw.slice(0, POD_UI_HOST_MAX_LINE_BYTES).toWellFormed()
  if (text.length === raw.length && fits(text, true)) {
    return { ...menu, selectionText: text }
  }
  // The longest prefix that fits.
  let low = 0
  let high = text.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (fits(text.slice(0, mid), false)) {
      low = mid
    } else {
      high = mid - 1
    }
  }
  const cut = text.slice(0, low)
  // Why: never half a surrogate pair.
  const whole = /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut
  return { ...menu, selectionText: whole, selectionComplete: false }
}
