// Fork-only (Pod): agent browser pages in a windowless host sleep while nothing needs them drawn.
// A sleeping page is hidden and throttled: no frames, timers at background rates. Every wake is a
// lease on the shared renderer publication throttle, so its re-hide logic is the one that runs.
import {
  rendererPublicationThrottle,
  type RendererPublicationThrottleTarget
} from '../../window/renderer-publication-throttle'

// Why: agent-browser waits on frames and timers between commands; a page that went back to sleep
// between two commands would stall the next one's actionability checks.
export const GUEST_ACTIVITY_WAKE_MS = 10_000

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
