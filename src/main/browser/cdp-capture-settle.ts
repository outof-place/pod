import type { WebContents } from 'electron'
import { acquireElectronDebugger } from './electron-debugger-lease'

// Why: Chromium puts a capture's temporary view size, emulation and web prefs back only when it
// answers the capture. A detach before that drops the answer, so the page keeps them for good; a
// capture or emulation change sent before it takes the temporary state for the page's own, and its
// own answer later puts it back. So unanswered capture requests keep the debugger attached, and the
// next capture or viewport change on the page waits for them.
const unsettledCaptures = new WeakMap<WebContents, Promise<void>>()

// While waiting, the page is asked to draw: an undrawn page answers only with a new frame.
const NUDGE_INTERVAL_MS = 250

// As long as a capture itself may take: whatever waits for one waits no longer.
export const CAPTURE_SETTLE_WAIT_MS = 8_000

export const CAPTURE_STILL_SETTLING_MESSAGE =
  'The page is still finishing an earlier screenshot; try again in a few seconds.'

/** Keeps the debugger attached until every request answers, then runs `onSettled`. */
export function keepCaptureUntilSettled(
  webContents: WebContents,
  requests: readonly Promise<unknown>[],
  onSettled: () => void
): void {
  if (requests.length === 0) {
    onSettled()
    return
  }
  // Why only while attached: a detach already rejected the requests, and a lease would attach again.
  let lease: { release: () => void } | null = null
  try {
    lease =
      !webContents.isDestroyed() && webContents.debugger.isAttached()
        ? acquireElectronDebugger(webContents)
        : null
  } catch {
    // The tab is gone: nothing is left to restore.
  }
  const earlier = unsettledCaptures.get(webContents)
  const settled: Promise<void> = Promise.allSettled([...requests, earlier]).then(() => {
    lease?.release()
    onSettled()
    if (unsettledCaptures.get(webContents) === settled) {
      unsettledCaptures.delete(webContents)
    }
  })
  unsettledCaptures.set(webContents, settled)
}

/** Resolves once no earlier capture on the page is unanswered; rejects if one still is after `timeoutMs`. */
export async function waitForSettledCaptures(
  webContents: WebContents,
  timeoutMs = CAPTURE_SETTLE_WAIT_MS
): Promise<void> {
  const pending = unsettledCaptures.get(webContents)
  if (!pending) {
    return
  }
  let deadline: ReturnType<typeof setTimeout> | null = null
  const nudge = setInterval(() => {
    try {
      if (!webContents.isDestroyed()) {
        webContents.invalidate()
      }
    } catch {
      // A page in teardown refuses repaints; its requests reject on detach.
    }
  }, NUDGE_INTERVAL_MS)
  try {
    const outcome = await Promise.race([
      pending.then(() => 'settled' as const),
      new Promise<'late'>((resolve) => {
        deadline = setTimeout(() => resolve('late'), timeoutMs)
      })
    ])
    if (outcome === 'late') {
      throw new Error(CAPTURE_STILL_SETTLING_MESSAGE)
    }
  } finally {
    clearInterval(nudge)
    if (deadline) {
      clearTimeout(deadline)
    }
  }
}
