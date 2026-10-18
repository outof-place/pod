// Fork-only (Pod): co-browse on one-app's pane pages, between the pane controller and PaneCobrowse.
import type { WebContents } from 'electron'
import type { CobrowseBox } from '../../../shared/browser-cobrowse-types'
import { acquireElectronDebugger } from '../../browser/electron-debugger-lease'
import { sendGuestCdpCommand } from '../../browser/guest-cdp-command'
import { captureScreenshot } from '../../browser/cdp-screenshot'
import { PaneCobrowse } from './pod-browser-cobrowse'
import type { PointRequest } from './pod-browser-cobrowse-anchors'
import type { CobrowseCdp } from './pod-browser-cobrowse-cdp'
import {
  isPodBrowserCobrowseMessage,
  type PodBrowserCobrowseServerMessage
} from './pod-browser-cobrowse-protocol'

// Each tracked pane page's co-browse, by page id, while its WebContents lives.
const pages = new Map<string, PaneCobrowse>()

/** Co-browse on a pane page (browser.marks, browser.point); null when no pane controller hosts it. */
export function paneCobrowse(pageId: string): PaneCobrowse | null {
  return pages.get(pageId) ?? null
}

type PaneSide = { token: number | null; visible: boolean }

/** Co-browse on a page the pane controller tracks, from now until its WebContents is destroyed. */
export function newPaneCobrowse(
  pageId: string,
  wc: WebContents,
  send: (message: PodBrowserCobrowseServerMessage) => boolean,
  pane: () => PaneSide,
  log: (message: string) => void
): PaneCobrowse {
  // The page's debugger lease: taken on first use, released when nothing is tracked.
  let lease: { release: () => void } | null = null
  const cdp: CobrowseCdp = (method, params) => sendGuestCdpCommand(wc, method, params)
  const cobrowse = new PaneCobrowse({
    pageId,
    cdp: () => {
      if (wc.isDestroyed()) {
        return null
      }
      lease ??= acquireElectronDebugger(wc)
      return cdp
    },
    releaseCdp: () => {
      lease?.release()
      lease = null
    },
    // A clip inside the viewport: nothing resizes, so the pane needs no frame hold.
    capture: async (clip) => {
      const options = { format: 'png', clip, optimizeForSpeed: true }
      return (await captureScreenshot(wc, options, () => () => {})).data
    },
    send: (message) => {
      if (pane().token !== null) {
        send(message)
      }
    },
    attached: () => pane().token !== null,
    paneShown: () => pane().token !== null && pane().visible,
    page: () => ({ url: wc.getURL(), title: wc.getTitle() }),
    zoom: () => {
      const zoom = wc.getZoomFactor()
      return Number.isFinite(zoom) && zoom > 0 ? zoom : 1
    },
    log
  })
  pages.set(pageId, cobrowse)
  // Its marks, pointers and hover may move with each frame the page paints.
  wc.on('paint', () => cobrowse.onPaint())
  wc.once('destroyed', () => {
    cobrowse.dispose()
    if (pages.get(pageId) === cobrowse) {
      pages.delete(pageId)
    }
  })
  return cobrowse
}

// Both answer their own failures; this only keeps a bug from becoming an unhandled rejection.
function logged(error: unknown): void {
  console.warn('[browser-cobrowse]', error instanceof Error ? error.message : String(error))
}

/** A pane verb for co-browse, done; false for any other verb. */
export function handlePaneCobrowse(message: { type: string; pageId?: string }): boolean {
  const cobrowse = message.pageId === undefined ? null : pages.get(message.pageId)
  if (!isPodBrowserCobrowseMessage(message) || !cobrowse) {
    return false
  }
  switch (message.type) {
    case 'browserCobrowse':
      cobrowse.setWatching(message.watch)
      break
    case 'browserMarkMode':
      cobrowse.setMarkMode(message.on)
      break
    case 'browserHover':
      void cobrowse.hoverAt(message.x, message.y, message.seq).catch(logged)
      break
    case 'browserHoverEnd':
      cobrowse.hoverEnd()
      break
    case 'browserMarkAdd':
      void cobrowse
        .addMark(message.markId, message.x, message.y, message.width, message.height)
        .catch(logged)
      break
    case 'browserMarkNote':
      cobrowse.setNote(message.markId, message.note)
      break
    case 'browserMarkRemove':
      cobrowse.removeMark(message.markId)
      break
    case 'browserMarksSend':
      cobrowse.send()
  }
  return true
}

/** `browser.point` on a pane page: a new pointer, or the agent's cleared. */
export async function pointOnPane(
  cobrowse: PaneCobrowse,
  request: PointRequest | { clear: true; pointerId?: string }
): Promise<{ pointerId: string | null; box: CobrowseBox | null; shown: boolean; cleared: number }> {
  if ('clear' in request) {
    const cleared = cobrowse.clearPointers(request.pointerId)
    return { pointerId: null, box: null, shown: cobrowse.shownToUser, cleared }
  }
  const { pointerId, box } = await cobrowse.point(request)
  return { pointerId, box, shown: cobrowse.shownToUser, cleared: 0 }
}
