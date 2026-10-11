// Fork-only (Pod): agent browser pages in a windowless host sleep while nothing needs them drawn.
// A sleeping page is hidden and throttled: no frames, timers at background rates. Every wake is a
// lease on the shared renderer publication throttle, so its re-hide logic is the one that runs.
import {
  rendererPublicationThrottle,
  type RendererPublicationThrottleTarget
} from '../../window/renderer-publication-throttle'
import { addPodCdpProxySink } from '../browser/cdp-proxy-hooks'
import { isPodUiHostLaunch } from '../ui-host/pod-ui-host-launch'
import { isPodHeadlessHost } from './headless-host-mode'

// Why: agent-browser waits on frames and timers between commands; a page that went back to sleep
// between two commands would stall the next one's actionability checks.
export const GUEST_ACTIVITY_WAKE_MS = 10_000
// Why a cap: a CDP command whose reply never comes (its page died mid-call) must not pin a page awake.
export const CDP_COMMAND_WAKE_CAP_MS = 5 * 60_000

/** A launch whose pages no one looks at by default: the serve headless host, or the one-app runtime. */
export function isPodWindowlessHost(): boolean {
  return isPodHeadlessHost() || isPodUiHostLaunch()
}

export type GuestPageSleepTarget = RendererPublicationThrottleTarget & {
  id: number
  once: (event: 'destroyed', listener: () => void) => unknown
}

type Leases = { acquire: (target: RendererPublicationThrottleTarget) => () => void }

type TrackedGuest = {
  target: GuestPageSleepTarget
  releaseActivity: (() => void) | null
  activityTimer: ReturnType<typeof setTimeout> | null
}

export class GuestPageSleep {
  private readonly guests = new Map<number, TrackedGuest>()

  constructor(
    private readonly leases: Leases = rendererPublicationThrottle,
    private readonly activityWakeMs = GUEST_ACTIVITY_WAKE_MS
  ) {}

  /** Puts a guest to sleep now. Call after the guest policy, which leaves throttling off. */
  track(target: GuestPageSleepTarget): void {
    if (this.guests.has(target.id) || target.isDestroyed?.() === true) {
      return
    }
    this.guests.set(target.id, { target, releaseActivity: null, activityTimer: null })
    // Why a lease cycle, not setBackgroundThrottling(true): only the last release replays the hide
    // that the policy's setBackgroundThrottling(false) swallowed, so the page actually stops drawing.
    this.leases.acquire(target)()
    target.once('destroyed', () => this.forget(target.id))
  }

  isTracked(guestId: number): boolean {
    return this.guests.has(guestId)
  }

  /** Keeps the guest drawing until the returned release runs. A no-op for an untracked guest. */
  wake(guestId: number): () => void {
    const guest = this.guests.get(guestId)
    return guest ? this.leases.acquire(guest.target) : () => {}
  }

  /** Holds the guest awake while a command runs; the release starts the after-command window. */
  beginCommand(guestId: number): () => void {
    const release = this.wake(guestId)
    let ended = false
    return () => {
      if (ended) {
        return
      }
      ended = true
      // Why activity first: its lease is taken before the command's is dropped, so no sleep between.
      this.noteActivity(guestId)
      release()
    }
  }

  async whileAwake<T>(guestId: number, run: () => Promise<T>): Promise<T> {
    const end = this.beginCommand(guestId)
    try {
      return await run()
    } finally {
      end()
    }
  }

  /** A command reached the guest: it stays awake until GUEST_ACTIVITY_WAKE_MS after the last one. */
  noteActivity(guestId: number): void {
    const guest = this.guests.get(guestId)
    if (!guest) {
      return
    }
    guest.releaseActivity ??= this.leases.acquire(guest.target)
    if (guest.activityTimer) {
      clearTimeout(guest.activityTimer)
    }
    guest.activityTimer = setTimeout(() => this.endActivity(guest), this.activityWakeMs)
    guest.activityTimer.unref?.()
  }

  private endActivity(guest: TrackedGuest): void {
    if (guest.activityTimer) {
      clearTimeout(guest.activityTimer)
      guest.activityTimer = null
    }
    const release = guest.releaseActivity
    guest.releaseActivity = null
    release?.()
  }

  private forget(guestId: number): void {
    const guest = this.guests.get(guestId)
    if (!guest) {
      return
    }
    this.guests.delete(guestId)
    // Why release on destroy: the throttle keys leases by target and would keep this one forever.
    this.endActivity(guest)
  }
}

export const podGuestPageSleep = new GuestPageSleep()

/**
 * Puts a browsing guest to sleep in a windowless host. Offscreen-rendered pages are left alone:
 * the pane that shows one starts and stops its painting.
 */
export function trackPodGuestPageSleep(
  guest: GuestPageSleepTarget & { isOffscreen?: () => boolean },
  sleep: GuestPageSleep = podGuestPageSleep,
  windowless: boolean = isPodWindowlessHost()
): void {
  if (windowless && guest.isOffscreen?.() !== true) {
    installPodCdpCommandWakes()
    sleep.track(guest)
  }
}

/** The serve headless host's page windows start hidden, or throttling could never hide them. */
export function podOffscreenPageWindowOptions(windowless: boolean = isPodWindowlessHost()): {
  paintWhenInitiallyHidden?: boolean
} {
  return windowless ? { paintWhenInitiallyHidden: false } : {}
}

/** Keeps a page awake from each agent CDP request until its reply (sinks of cdp-proxy-hooks.ts). */
export class PodCdpCommandWakes {
  private readonly inFlight = new Map<
    string,
    { end: () => void; cap: ReturnType<typeof setTimeout> }
  >()

  constructor(private readonly sleep: GuestPageSleep = podGuestPageSleep) {}

  request(guestId: number, clientId: number): void {
    // Why: a reused id means its old reply is never coming.
    this.reply(guestId, clientId)
    if (!this.sleep.isTracked(guestId)) {
      return
    }
    // Why the cap also covers a client that left mid-command: the proxy reports no disconnects.
    const cap = setTimeout(() => this.reply(guestId, clientId), CDP_COMMAND_WAKE_CAP_MS)
    cap.unref?.()
    this.inFlight.set(`${guestId}:${clientId}`, { end: this.sleep.beginCommand(guestId), cap })
  }

  reply(guestId: number, clientId: number): void {
    const key = `${guestId}:${clientId}`
    const command = this.inFlight.get(key)
    if (!command) {
      return
    }
    this.inFlight.delete(key)
    clearTimeout(command.cap)
    command.end()
  }
}

let cdpCommandWakesInstalled = false

/** Hears the agent CDP proxy once page sleep has a page to keep awake. */
function installPodCdpCommandWakes(): void {
  if (cdpCommandWakesInstalled) {
    return
  }
  cdpCommandWakesInstalled = true
  const wakes = new PodCdpCommandWakes()
  addPodCdpProxySink({
    request: (guestId, clientId) => wakes.request(guestId, clientId),
    reply: (guestId, clientId) => wakes.reply(guestId, clientId)
  })
}
