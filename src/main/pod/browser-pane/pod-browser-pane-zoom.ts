// Fork-only (Pod): a pane page's zoom, held per page as Pod's tabs hold theirs
// (use-browser-page-webview-shortcuts.ts, browser-page-webview-guest-session.ts).
import type { WebContents } from 'electron'
import {
  nextBrowserPageZoomLevel,
  normalizeBrowserPageZoomLevel,
  type BrowserPageZoomDirection
} from '../../../shared/browser-page-zoom'
import { resolveGuestMouseWheelZoomDirection } from '../../browser/browser-guest-wheel-zoom'
import type { PaneInputAction } from './pod-browser-pane-input'

/** One page's zoom level. Chromium keeps one per host, so a page of the same host can move it. */
export class PaneZoom {
  private level: number

  constructor(
    private readonly wc: WebContents,
    // Pod's browserDefaultZoomLevel: a new page starts there, as a new tab does.
    seed: number | undefined,
    private readonly changed: () => void
  ) {
    this.level = normalizeBrowserPageZoomLevel(seed)
    // Why each load: Chromium gives a new document its host's zoom, as Pod's tabs reassert theirs.
    wc.on('dom-ready', () => this.apply())
  }

  /** Reset goes to 100% as in Chromium; the default only seeds new pages (Pod's tabs too). */
  step(direction: BrowserPageZoomDirection): void {
    this.level = nextBrowserPageZoomLevel(this.level, direction)
    this.apply()
    this.changed()
  }

  /**
   * A ⌘ or ⌃ scroll zooms instead of scrolling, as in Pod's tabs. Why not zoom-changed: Chromium
   * reports a ⌃ scroll there on every platform but macOS.
   */
  takesWheel(action: PaneInputAction): boolean {
    const input = action.kind === 'send' && action.input.type === 'mouseWheel' ? action.input : null
    const direction = input ? resolveGuestMouseWheelZoomDirection(input) : null
    if (direction) {
      this.step(direction)
    }
    return direction !== null
  }

  private apply(): void {
    // Why compare first: a write moves every page of the host, even to the level it has.
    if (normalizeBrowserPageZoomLevel(this.wc.getZoomLevel()) !== this.level) {
      this.wc.setZoomLevel(this.level)
    }
  }
}
