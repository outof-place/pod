// Fork-only (Pod): PodNative's input for one offscreen page.
import type { WebContents } from 'electron'
import { applyPaneInput, type PaneInputState } from './pod-browser-pane-input'
import type { PaneLinks } from './pod-browser-pane-links'
import type { PodBrowserInputEvent } from './pod-browser-pane-protocol'
import type { PaneSelectMenus } from './pod-browser-pane-select'
import type { PaneZoom } from './pod-browser-pane-zoom'

/** The page's links and select menus note it first; a ⌃ scroll zooms, the rest reaches the page. */
export function applyPanePageInput(
  page: {
    wc: WebContents
    input: PaneInputState
    links: PaneLinks
    select: PaneSelectMenus
    zoom: PaneZoom
  },
  event: PodBrowserInputEvent
): void {
  page.links.noteInput(event)
  if (event.kind === 'mouse' && event.action === 'down' && event.button === 'left') {
    page.select.noteClick(event.x, event.y)
  }
  const action = page.input.map(event)
  if (!page.zoom.takesWheel(action)) {
    applyPaneInput(page.wc, action)
  }
}
