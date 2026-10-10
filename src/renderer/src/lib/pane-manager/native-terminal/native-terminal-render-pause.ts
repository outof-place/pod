import type { IDisposable, Terminal } from '@xterm/xterm'

// While a native surface covers its pane, xterm keeps parsing every byte but need not paint.
// Moving xterm's screen out of the viewport trips xterm's own IntersectionObserver pause,
// which folds every refresh into one full repaint on resume. Why not display:none: the
// helper textarea lives inside the screen and must keep DOM focus (paste/copy ownership).
const PAUSED_TRANSFORM = 'translateX(-100000px)'
// Lets the native view present before xterm stops painting underneath it.
const PAUSE_DELAY_MS = 200
// Bounds how long a hiding native view waits on xterm's repaint (DEC 2026 can defer it).
const REPAINT_TIMEOUT_MS = 250
// Bounds how long a hiding native view waits on a detached xterm catching up from main.
const REATTACH_TIMEOUT_MS = 1_000

// Terminals whose screen sits out of view under a native surface.
const pausedUnderNativeView = new WeakSet<object>()

// Why: Orca's forced presents clear xterm's pause latch, and the observer never re-pauses a
// screen that stays out of view; they skip these terminals (full repaint on resume instead).
export function isXtermPausedUnderNativeView(terminal: unknown): boolean {
  return typeof terminal === 'object' && terminal !== null && pausedUnderNativeView.has(terminal)
}

// Parse once: how a paused xterm leaves the PTY byte stream and catches up again.
export type NativeTerminalXtermFeed = {
  // False when xterm keeps parsing (parse once is off, or main cannot take the bytes).
  detach: () => boolean
  // Resolves once xterm holds the current screen again.
  reattach: () => Promise<void>
}

export type NativeTerminalRenderPause = {
  // Follows whether the native view is on screen: pause, or repaint before it hides.
  setShown: (shown: boolean) => void
  // The native view is on screen.
  pause: () => void
  // The native view is about to hide: repaint xterm, then call onRepainted.
  resume: (onRepainted: () => void) => void
  // True while xterm's own screen may not show the current buffer.
  isStale: () => boolean
  // While paused, xterm leaves the byte stream through `feed` (null: it keeps parsing).
  setFeed: (feed: NativeTerminalXtermFeed | null) => void
  dispose: () => void
}

export function createNativeTerminalRenderPause(
  terminal: Terminal,
  afterRepaint: () => void = () => {}
): NativeTerminalRenderPause {
  let phase: 'live' | 'paused' | 'repainting' = 'live'
  let pauseTimer: ReturnType<typeof setTimeout> | null = null
  let repaintTimer: ReturnType<typeof setTimeout> | null = null
  let renderListener: IDisposable | null = null
  let feed: NativeTerminalXtermFeed | null = null
  let detachedFeed: NativeTerminalXtermFeed | null = null
  // Why: a newer pause or resume supersedes a resume still waiting on its reattach.
  let resumeGeneration = 0

  const detachFeed = (): void => {
    if (feed && !detachedFeed && feed.detach()) {
      detachedFeed = feed
    }
  }

  const reattachFeed = (): Promise<void> => {
    const detached = detachedFeed
    detachedFeed = null
    return detached ? detached.reattach() : Promise.resolve()
  }

  const screen = (): HTMLElement | null =>
    terminal.element?.querySelector<HTMLElement>('.xterm-screen') ?? null

  const cancelPending = (): void => {
    if (pauseTimer !== null) {
      clearTimeout(pauseTimer)
      pauseTimer = null
    }
    if (repaintTimer !== null) {
      clearTimeout(repaintTimer)
      repaintTimer = null
    }
    renderListener?.dispose()
    renderListener = null
    resumeGeneration += 1
  }

  const unpause = (): void => {
    pausedUnderNativeView.delete(terminal)
    const element = screen()
    if (element && element.style.transform === PAUSED_TRANSFORM) {
      element.style.transform = ''
    }
  }

  const pause: NativeTerminalRenderPause = {
    setShown: (shown) => (shown ? pause.pause() : pause.resume(afterRepaint)),
    pause: () => {
      cancelPending()
      if (phase === 'paused') {
        return
      }
      phase = 'live'
      pauseTimer = setTimeout(() => {
        pauseTimer = null
        const element = screen()
        if (element) {
          element.style.transform = PAUSED_TRANSFORM
          pausedUnderNativeView.add(terminal)
          phase = 'paused'
          detachFeed()
        }
      }, PAUSE_DELAY_MS)
    },
    resume: (onRepainted) => {
      cancelPending()
      if (phase === 'live') {
        return
      }
      phase = 'repainting'
      const generation = resumeGeneration
      const repaint = (): void => {
        if (generation !== resumeGeneration) {
          return
        }
        unpause()
        const finish = (): void => {
          cancelPending()
          phase = 'live'
          onRepainted()
        }
        renderListener = terminal.onRender(finish)
        repaintTimer = setTimeout(finish, REPAINT_TIMEOUT_MS)
        // Still paused until the observer fires, so this only guarantees a full repaint then.
        terminal.refresh(0, terminal.rows - 1)
      }
      if (!detachedFeed) {
        repaint()
        return
      }
      // The native view keeps covering the pane until xterm caught up, then the repaint.
      const caughtUp = reattachFeed().catch(() => {})
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, REATTACH_TIMEOUT_MS))
      void Promise.race([caughtUp, timeout]).then(repaint)
    },
    isStale: () => phase !== 'live',
    setFeed: (next) => {
      if (next === feed) {
        return
      }
      feed = next
      if (detachedFeed && detachedFeed !== next) {
        void reattachFeed()
      }
      if (phase === 'paused') {
        detachFeed()
      }
    },
    dispose: () => {
      cancelPending()
      unpause()
      phase = 'live'
      feed = null
      void reattachFeed()
    }
  }
  return pause
}
