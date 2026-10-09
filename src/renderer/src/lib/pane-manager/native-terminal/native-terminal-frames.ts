import type { NativeTerminalFrame } from '../../../../../shared/native-terminal-ipc'
import { cssPxToWindowDip } from '../../ui-zoom'

// Places every native terminal surface of this window over its pane, and hides it whenever
// DOM UI (dialogs, menus, popovers, in-pane search) overlaps the pane: the hidden xterm
// underneath holds the same screen, so the overlay renders on top of identical content.
export type NativeTerminalFrameEntry = {
  surfaceId: number
  element: HTMLElement
  isShown: () => boolean
  onShownChange: (shown: boolean) => void
  // True while the xterm under the view may not show the current buffer yet.
  isDomViewStale?: () => boolean
}

// Portaled Radix UI, ARIA popups, and anything else that opts in.
const OVERLAY_SELECTOR = [
  '[data-radix-popper-content-wrapper]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '[data-terminal-search-root]',
  '.pane-drop-overlay',
  '[data-native-terminal-overlay]'
].join(',')

// Pane chrome drawn over the terminal's top edge (title bar, split/close actions). The native
// view starts below it so the controls stay clickable; hover-independent so the grid holds.
const TOP_CHROME_SELECTOR = '.pane-title-bar, [data-native-terminal-exclude]'

const SAFETY_POLL_MS = 500

type Tracked = NativeTerminalFrameEntry & {
  lastFrame: NativeTerminalFrame | null
  lastShown: boolean
}

const tracked = new Map<number, Tracked>()
let rafId: number | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let resizeObserver: ResizeObserver | null = null
let mutationObserver: MutationObserver | null = null
let sendFrames: ((frames: NativeTerminalFrame[]) => void) | null = null

function intersects(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

function overlayRects(): DOMRect[] {
  const rects: DOMRect[] = []
  for (const element of document.querySelectorAll(OVERLAY_SELECTOR)) {
    const rect = element.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) {
      rects.push(rect)
    }
  }
  return rects
}

// Why the container's content box: xterm's own element is sized by its rows, and the
// native grid drives those rows, so tracking it would shrink the view one row at a time.
function contentBox(element: HTMLElement): DOMRect {
  const rect = element.getBoundingClientRect()
  const style = getComputedStyle(element)
  const left = Number.parseFloat(style.paddingLeft) || 0
  const right = Number.parseFloat(style.paddingRight) || 0
  const top = Number.parseFloat(style.paddingTop) || 0
  const bottom = Number.parseFloat(style.paddingBottom) || 0
  return new DOMRect(
    rect.left + left,
    rect.top + top,
    Math.max(0, rect.width - left - right),
    Math.max(0, rect.height - top - bottom)
  )
}

function belowTopChrome(box: DOMRect, chrome: DOMRect[]): DOMRect {
  let top = box.top
  for (const rect of chrome) {
    const overlapsTopEdge = rect.top <= top + 1 && rect.bottom > top && rect.bottom < box.bottom
    if (overlapsTopEdge && rect.left < box.right && box.left < rect.right) {
      top = rect.bottom
    }
  }
  return top === box.top ? box : new DOMRect(box.left, top, box.width, box.bottom - top)
}

function topChromeRects(): DOMRect[] {
  const rects: DOMRect[] = []
  for (const element of document.querySelectorAll(TOP_CHROME_SELECTOR)) {
    const rect = element.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) {
      rects.push(rect)
    }
  }
  return rects
}

function framesEqual(a: NativeTerminalFrame | null, b: NativeTerminalFrame): boolean {
  return a !== null && a.every((value, index) => value === b[index])
}

function flush(): void {
  rafId = null
  if (!sendFrames || tracked.size === 0) {
    return
  }
  const overlays = overlayRects()
  const chrome = topChromeRects()
  const changed: NativeTerminalFrame[] = []
  for (const entry of tracked.values()) {
    const rect = belowTopChrome(contentBox(entry.element), chrome)
    const paneOnScreen =
      entry.isShown() && entry.element.isConnected && rect.width > 0 && rect.height > 0
    const onScreen = paneOnScreen && !overlays.some((overlay) => intersects(rect, overlay))
    // Why: an overlay hide keeps the view up until the paused xterm underneath has repainted.
    const visible = onScreen || (paneOnScreen && entry.isDomViewStale?.() === true)
    const frame: NativeTerminalFrame = [
      entry.surfaceId,
      cssPxToWindowDip(rect.left),
      cssPxToWindowDip(rect.top),
      cssPxToWindowDip(rect.width),
      cssPxToWindowDip(rect.height),
      visible
    ]
    if (!framesEqual(entry.lastFrame, frame)) {
      entry.lastFrame = frame
      changed.push(frame)
    }
    if (entry.lastShown !== onScreen) {
      entry.lastShown = onScreen
      entry.onShownChange(onScreen)
    }
  }
  if (changed.length > 0) {
    sendFrames(changed)
  }
}

export function scheduleNativeTerminalFrames(): void {
  if (rafId === null && tracked.size > 0) {
    rafId = requestAnimationFrame(flush)
  }
}

// Why: xterm's own DOM churns on every cursor blink and repaint; none of it moves a pane.
function isXtermInternalMutation(record: MutationRecord): boolean {
  const target = record.target instanceof Element ? record.target : record.target.parentElement
  return target?.closest('.xterm') != null
}

function onMutations(records: MutationRecord[]): void {
  if (!records.every(isXtermInternalMutation)) {
    scheduleNativeTerminalFrames()
  }
}

function start(): void {
  resizeObserver = new ResizeObserver(scheduleNativeTerminalFrames)
  mutationObserver = new MutationObserver(onMutations)
  // Why attributes too: overlays and pane visibility often toggle via style/class/hidden.
  mutationObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'class', 'hidden', 'data-state', 'open']
  })
  window.addEventListener('resize', scheduleNativeTerminalFrames)
  // Why: pane moves that change no size (sidebar animations) are invisible to observers.
  pollTimer = setInterval(scheduleNativeTerminalFrames, SAFETY_POLL_MS)
}

function stop(): void {
  resizeObserver?.disconnect()
  mutationObserver?.disconnect()
  resizeObserver = null
  mutationObserver = null
  window.removeEventListener('resize', scheduleNativeTerminalFrames)
  if (pollTimer !== null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  if (rafId !== null) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
}

export function trackNativeTerminalFrame(
  entry: NativeTerminalFrameEntry,
  send: (frames: NativeTerminalFrame[]) => void
): () => void {
  sendFrames = send
  if (tracked.size === 0) {
    start()
  }
  tracked.set(entry.surfaceId, { ...entry, lastFrame: null, lastShown: false })
  resizeObserver?.observe(entry.element)
  scheduleNativeTerminalFrames()
  return () => {
    resizeObserver?.unobserve(entry.element)
    tracked.delete(entry.surfaceId)
    if (tracked.size === 0) {
      stop()
    }
  }
}

export function isNativeTerminalShown(surfaceId: number): boolean {
  return tracked.get(surfaceId)?.lastShown === true
}
