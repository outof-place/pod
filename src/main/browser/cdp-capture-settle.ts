import type { WebContents } from 'electron'
import { acquireElectronDebugger } from './electron-debugger-lease'

// Why: Chromium puts a capture's temporary view size, emulation and web prefs back only when it
// answers the capture. A detach before that drops the answer, so the page keeps them for good; a
// capture or emulation change sent before it takes the temporary state for the page's own, and its
// own answer later puts it back. Fork-only (Pod): an offscreen page shows a clipped capture's clip
// as its view, so even two quick clips leave it showing the first. So captures on a page take turns,
// each waiting until every request of the one before answered; unanswered requests keep the
// debugger attached, and a viewport change waits for them too.
const captureTurns = new WeakMap<WebContents, Promise<void>>()

// While waiting, the page is asked to draw: an undrawn page answers only with a new frame.
const NUDGE_INTERVAL_MS = 250

// As long as a capture itself may take: whatever waits for one waits no longer.
export const CAPTURE_SETTLE_WAIT_MS = 8_000

export const CAPTURE_STILL_SETTLING_MESSAGE =
  'The page is still finishing an earlier screenshot; try again in a few seconds.'

/** Ends a capture's turn once every request answered (the debugger stays attached till then), after `onSettled`. */
export type CaptureTurn = (requests: readonly Promise<unknown>[], onSettled: () => void) => void

/**
 * Waits until no earlier capture on the page is running or unanswered, then holds the page for this
 * one; rejects if one still is after `timeoutMs`.
 */
export async function takeCaptureTurn(
  webContents: WebContents,
  timeoutMs = CAPTURE_SETTLE_WAIT_MS
): Promise<CaptureTurn> {
  let pending = captureTurns.get(webContents)
  if (pending) {
    let deadline: ReturnType<typeof setTimeout> | null = null
    const late = new Promise<'late'>((resolve) => {
      deadline = setTimeout(() => resolve('late'), timeoutMs)
    })
    const nudge = setInterval(() => nudgePage(webContents), NUDGE_INTERVAL_MS)
    try {
      // Why a loop: of the captures one answer wakes, the first takes the page and the rest wait on.
      while (pending) {
        if ((await Promise.race([pending.then(() => 'settled' as const), late])) === 'late') {
          throw new Error(CAPTURE_STILL_SETTLING_MESSAGE)
        }
        pending = captureTurns.get(webContents)
      }
    } finally {
      clearInterval(nudge)
      if (deadline) {
        clearTimeout(deadline)
      }
    }
  }
  let handOn = (): void => {}
  const turn = new Promise<void>((resolve) => {
    handOn = resolve
  })
  captureTurns.set(webContents, turn)
  return (requests, onSettled) => {
    const lease = requests.length > 0 ? leaseWhileAttached(webContents) : null
    const settle = (): void => {
      try {
        lease?.release()
        onSettled()
      } catch (error) {
        // Why not rethrow: callers end turns from timers, where a throw is fatal to main.
        console.warn('[cdp-capture]', error instanceof Error ? error.message : String(error))
      } finally {
        if (captureTurns.get(webContents) === turn) {
          captureTurns.delete(webContents)
        }
        handOn()
      }
    }
    if (requests.length === 0) {
      settle()
      return
    }
    void Promise.allSettled(requests).then(settle)
  }
}

/** Resolves once no capture on the page is running or unanswered; rejects if one still is after `timeoutMs`. */
export async function waitForSettledCaptures(
  webContents: WebContents,
  timeoutMs = CAPTURE_SETTLE_WAIT_MS
): Promise<void> {
  if (captureTurns.has(webContents)) {
    ;(await takeCaptureTurn(webContents, timeoutMs))([], () => {})
  }
}

// Why only while attached: a detach already rejected the requests, and a lease would attach again.
function leaseWhileAttached(webContents: WebContents): { release: () => void } | null {
  try {
    return !webContents.isDestroyed() && webContents.debugger.isAttached()
      ? acquireElectronDebugger(webContents)
      : null
  } catch {
    // The tab is gone: nothing is left to restore.
    return null
  }
}

function nudgePage(webContents: WebContents): void {
  try {
    if (!webContents.isDestroyed()) {
      webContents.invalidate()
    }
  } catch {
    // A page in teardown refuses repaints; its requests reject on detach.
  }
}
