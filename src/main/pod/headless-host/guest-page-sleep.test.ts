import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RendererPublicationThrottle } from '../../window/renderer-publication-throttle'
import { podCdpProxyReply, podCdpProxyRequest } from '../browser/cdp-proxy-hooks'
import {
  CDP_COMMAND_WAKE_CAP_MS,
  GUEST_ACTIVITY_WAKE_MS,
  GuestPageSleep,
  PodCdpCommandWakes,
  podGuestPageSleep,
  podOffscreenPageWindowOptions,
  trackPodGuestPageSleep,
  type GuestPageSleepTarget
} from './guest-page-sleep'

function createGuest(id = 7): GuestPageSleepTarget & {
  throttling: boolean[]
  rehides: number
  destroy: () => void
} {
  let destroyed = false
  let onDestroyed: (() => void) | null = null
  const throttling: boolean[] = []
  const guest = {
    id,
    throttling,
    rehides: 0,
    isDestroyed: () => destroyed,
    isFocused: () => false,
    setBackgroundThrottling: (allowed: boolean) => {
      guest.throttling.push(allowed)
    },
    capturePage: async (_rect: unknown, opts: { stayHidden: boolean }) => {
      if (opts.stayHidden) {
        guest.rehides++
      }
      return null
    },
    once: (_event: 'destroyed', listener: () => void) => {
      onDestroyed = listener
    },
    destroy: () => {
      destroyed = true
      onDestroyed?.()
    }
  }
  return guest
}

/** Whether background throttling is on now, i.e. the page sleeps. */
function sleeping(guest: { throttling: boolean[] }): boolean {
  return guest.throttling.at(-1) === true
}

describe('GuestPageSleep', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('puts a tracked guest to sleep and replays the hide its policy swallowed', () => {
    const sleep = new GuestPageSleep(new RendererPublicationThrottle())
    const guest = createGuest()

    sleep.track(guest)
    sleep.track(guest)

    expect(guest.throttling).toEqual([false, true])
    expect(guest.rehides).toBe(1)
    expect(sleep.isTracked(guest.id)).toBe(true)
  })

  it('keeps the guest drawing while any wake holds, and sleeps it after the last release', () => {
    const sleep = new GuestPageSleep(new RendererPublicationThrottle())
    const guest = createGuest()
    sleep.track(guest)

    const releaseCapture = sleep.wake(guest.id)
    const releaseScreencast = sleep.wake(guest.id)
    expect(sleeping(guest)).toBe(false)
    releaseCapture()
    expect(sleeping(guest)).toBe(false)
    releaseScreencast()
    expect(sleeping(guest)).toBe(true)
    expect(guest.rehides).toBe(2)
  })

  it('stays awake until the activity window after the last command has passed', () => {
    const sleep = new GuestPageSleep(new RendererPublicationThrottle())
    const guest = createGuest()
    sleep.track(guest)

    sleep.noteActivity(guest.id)
    vi.advanceTimersByTime(GUEST_ACTIVITY_WAKE_MS - 1)
    sleep.noteActivity(guest.id)
    vi.advanceTimersByTime(GUEST_ACTIVITY_WAKE_MS - 1)
    expect(sleeping(guest)).toBe(false)
    // Why one wake per burst: repeated commands extend the window without stacking leases.
    expect(guest.throttling).toEqual([false, true, false])
    vi.advanceTimersByTime(1)
    expect(sleeping(guest)).toBe(true)
  })

  it('leaves untracked guests alone, so desktop guests keep drawing', () => {
    const sleep = new GuestPageSleep(new RendererPublicationThrottle())
    const guest = createGuest()

    sleep.wake(guest.id)()
    sleep.noteActivity(guest.id)
    vi.runAllTimers()

    expect(guest.throttling).toEqual([])
    expect(sleep.isTracked(guest.id)).toBe(false)
  })

  it('forgets a destroyed guest and drops its activity lease', () => {
    const throttle = new RendererPublicationThrottle()
    const sleep = new GuestPageSleep(throttle)
    const guest = createGuest()
    sleep.track(guest)
    sleep.noteActivity(guest.id)

    guest.destroy()
    vi.runAllTimers()

    expect(sleep.isTracked(guest.id)).toBe(false)
    // Why: a released lease on a destroyed target touches it no more; nothing after the wake.
    expect(guest.throttling).toEqual([false, true, false])
    // A fresh lease after destroy starts from zero, so the old one was dropped.
    throttle.acquire(guest)()
    expect(guest.throttling).toEqual([false, true, false, false])
  })

  it('skips a guest that is already destroyed', () => {
    const sleep = new GuestPageSleep(new RendererPublicationThrottle())
    const guest = createGuest()
    guest.destroy()

    sleep.track(guest)

    expect(guest.throttling).toEqual([])
    expect(sleep.isTracked(guest.id)).toBe(false)
  })

  it('holds a page awake for the whole command, then for the window after it', async () => {
    const sleep = new GuestPageSleep(new RendererPublicationThrottle())
    const guest = createGuest()
    sleep.track(guest)
    let finish!: () => void

    const running = sleep.whileAwake(
      guest.id,
      () => new Promise<void>((resolve) => (finish = resolve))
    )
    // Why: a wait longer than the activity window must not see its page fall asleep under it.
    vi.advanceTimersByTime(GUEST_ACTIVITY_WAKE_MS * 3)
    expect(sleeping(guest)).toBe(false)
    finish()
    await running
    expect(sleeping(guest)).toBe(false)
    vi.advanceTimersByTime(GUEST_ACTIVITY_WAKE_MS)
    expect(sleeping(guest)).toBe(true)
  })

  it('keeps a CDP page awake from each request until its reply', () => {
    const sleep = new GuestPageSleep(new RendererPublicationThrottle())
    const guest = createGuest()
    sleep.track(guest)
    const wakes = new PodCdpCommandWakes(sleep)

    wakes.request(guest.id, 1)
    wakes.request(guest.id, 2)
    vi.advanceTimersByTime(GUEST_ACTIVITY_WAKE_MS * 3)
    wakes.reply(guest.id, 1)
    vi.advanceTimersByTime(GUEST_ACTIVITY_WAKE_MS)
    expect(sleeping(guest)).toBe(false)
    wakes.reply(guest.id, 2)
    wakes.reply(guest.id, 2)
    vi.advanceTimersByTime(GUEST_ACTIVITY_WAKE_MS)
    expect(sleeping(guest)).toBe(true)
  })

  it('keys commands by page, and lets a page sleep when a reply never comes', () => {
    const sleep = new GuestPageSleep(new RendererPublicationThrottle())
    const guest = createGuest(7)
    const other = createGuest(8)
    sleep.track(guest)
    sleep.track(other)
    const wakes = new PodCdpCommandWakes(sleep)

    wakes.request(guest.id, 1)
    wakes.request(other.id, 1)
    wakes.reply(other.id, 1)
    vi.advanceTimersByTime(GUEST_ACTIVITY_WAKE_MS)
    expect(sleeping(other)).toBe(true)
    expect(sleeping(guest)).toBe(false)

    vi.advanceTimersByTime(CDP_COMMAND_WAKE_CAP_MS + GUEST_ACTIVITY_WAKE_MS)
    expect(sleeping(guest)).toBe(true)
  })

  it('hears the agent CDP proxy once it tracks a page', () => {
    const guest = createGuest(41)
    trackPodGuestPageSleep(guest, podGuestPageSleep, true)
    podCdpProxyRequest(guest.id, 1)
    vi.advanceTimersByTime(GUEST_ACTIVITY_WAKE_MS * 2)
    expect(sleeping(guest)).toBe(false)
    podCdpProxyReply(guest.id, 1)
    vi.advanceTimersByTime(GUEST_ACTIVITY_WAKE_MS)
    expect(sleeping(guest)).toBe(true)
    guest.destroy()
  })

  it('ignores commands to a page it does not track', () => {
    const sleep = new GuestPageSleep(new RendererPublicationThrottle())
    const guest = createGuest()
    const wakes = new PodCdpCommandWakes(sleep)
    wakes.request(guest.id, 1)
    expect(guest.throttling).toEqual([])
  })

  it('tracks only non-offscreen guests, and only in a windowless host', () => {
    const sleep = new GuestPageSleep(new RendererPublicationThrottle())
    const webview = createGuest(1)
    const paneSurface = Object.assign(createGuest(2), { isOffscreen: () => true })
    const desktopGuest = createGuest(3)

    trackPodGuestPageSleep(webview, sleep, true)
    trackPodGuestPageSleep(paneSurface, sleep, true)
    trackPodGuestPageSleep(desktopGuest, sleep, false)

    expect([1, 2, 3].map((id) => sleep.isTracked(id))).toEqual([true, false, false])
    expect(paneSurface.throttling).toEqual([])
  })

  it('starts serve page windows hidden only in a windowless host', () => {
    expect(podOffscreenPageWindowOptions(true)).toEqual({ paintWhenInitiallyHidden: false })
    expect(podOffscreenPageWindowOptions(false)).toEqual({})
  })
})
