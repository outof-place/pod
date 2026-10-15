// Fork-only (Pod): a pane's links, as Safari and Chrome treat them. The hovered link's URL goes to
// PodNative's status bubble (browserTargetUrl), and the page's new-tab opens, which no renderer
// takes for an offscreen page, go to PodNative with where the user's click asked for them
// (browserOpenLink). Electron-free so it is testable on its own.
import { normalizeExternalBrowserUrl, redactKagiSessionToken } from '../../../shared/browser-url'
import { BROWSER_GUEST_INPUT_GESTURE_WINDOW_MS } from '../../browser/browser-guest-input-gesture'
import { describePaneLink } from './pod-browser-pane-context-menu'
import type {
  PodBrowserInputEvent,
  PodBrowserLinkTarget,
  PodBrowserPaneServerMessage
} from './pod-browser-pane-protocol'

// Why 5 s: Chrome's transient user activation, which a page's new tab needs there too.
const TAB_GESTURE_WINDOW_MS = 5_000

type Gesture = {
  /** A ⌘-click or ⌘-Enter: its open may go to the default browser within a second. */
  defaultBrowser: boolean
  /** The button whose press armed it; null for a key. */
  button: 'left' | 'right' | 'middle' | null
  at: number
}

function onlyMeta(modifiers: readonly string[]): boolean {
  return (
    modifiers.includes('meta') &&
    !modifiers.some(
      (modifier) => modifier === 'shift' || modifier === 'control' || modifier === 'alt'
    )
  )
}

/** What PodNative's press asks of a link it opens; null for anything but a mouse or key down. */
function gestureOf(event: PodBrowserInputEvent, at: number): Gesture | null {
  if (event.kind === 'mouse' && event.action === 'down') {
    return {
      defaultBrowser: event.button === 'left' && onlyMeta(event.modifiers),
      button: event.button,
      at
    }
  }
  if (event.kind === 'key' && event.action === 'down') {
    // Why only Enter: the Edit menu sends ⌘C/⌘V/⌘A/⌘Z as key downs, and a page's copy handler
    // must not reach the default browser with them.
    return {
      defaultBrowser: event.keyCode === 'Enter' && onlyMeta(event.modifiers),
      button: null,
      at
    }
  }
  return null
}

export class PaneLinks {
  private shown = ''
  private gesture: Gesture | null = null

  constructor(
    private readonly pageId: string,
    private readonly send: (message: PodBrowserPaneServerMessage) => boolean,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** Electron's update-target-url; `userDriven` false (no pane, an agent drives) hides the bubble. */
  hover(raw: string, userDriven: boolean): void {
    const link = userDriven && raw ? describePaneLink(raw) : null
    const url = link ? redactKagiSessionToken(link) : ''
    if (url !== this.shown) {
      this.shown = url
      this.send({ type: 'browserTargetUrl', pageId: this.pageId, url })
    }
  }

  /** PodNative's own click or key (never an agent's): it lets one link open follow. */
  noteInput(event: PodBrowserInputEvent): void {
    const pressed = gestureOf(event, this.now())
    if (pressed) {
      this.gesture = pressed
    } else if (
      event.kind === 'mouse' &&
      event.action === 'up' &&
      this.gesture?.button === event.button
    ) {
      // Why: a click opens on its up; a press already spent on an open funds no second one.
      this.gesture = { ...this.gesture, at: this.now() }
    }
  }

  /** An agent's command: the bubble goes, and the user's last click opens nothing the agent brings. */
  noteAgentCommand(): void {
    this.hover('', false)
    this.gesture = null
  }

  /** A new-tab open of the page (Chromium's `activate` false: a background tab); false: nothing sent. */
  open(raw: string, activate: boolean): boolean {
    // Why first: as in Chrome, every open spends the click, a refused one too.
    const target = this.target(activate)
    const link = describePaneLink(raw)
    const url = link === null ? null : normalizeExternalBrowserUrl(link)
    if (target === null || url === null) {
      return false
    }
    // Why redacted only there: Pod's own tabs keep a Kagi session link working, as Orca's do.
    const sent = target === 'defaultBrowser' ? redactKagiSessionToken(url) : url
    return this.send({
      type: 'browserOpenLink',
      pageId: this.pageId,
      url: sent,
      target
    })
  }

  /** The pane went away or changed: nothing shown, no click pending. */
  reset(): void {
    this.shown = ''
    this.gesture = null
  }

  // Why single use: one click opens at most one link; null: no click asked for it.
  private target(activate: boolean): PodBrowserLinkTarget | null {
    const gesture = this.gesture
    this.gesture = null
    const age = gesture === null ? Infinity : this.now() - gesture.at
    if (gesture?.defaultBrowser && age <= BROWSER_GUEST_INPUT_GESTURE_WINDOW_MS) {
      return 'defaultBrowser'
    }
    if (age > TAB_GESTURE_WINDOW_MS) {
      return null
    }
    return activate ? 'foregroundTab' : 'backgroundTab'
  }
}
