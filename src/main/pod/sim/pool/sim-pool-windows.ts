// Fork-only (Pod): time as the pool core judges it. Every window (idle, reservation, takeover, a
// silent waiter, an op's deadline, the warm window, a tombstone's life) is measured on this
// runtime's monotonic clock from the moment this runtime first saw its start, never from a wall
// time in the registry: time no runtime observed (a sleep, a crash, a clock step) restarts a
// window instead of expiring it.
import { SIM_RESERVATION_CLAIM_S } from '../../../../shared/pod-sim/sim-call-limits'
import {
  dropAnchor,
  foldAnchors,
  forEachAnchor,
  getAnchor,
  setAnchor,
  SIM_ANCHOR_LAYER_MAX
} from './sim-pool-anchors'
import { SIM_CLOCK_STEP_MS } from './sim-pool-config'
import type { SimPoolDraft } from './sim-pool-draft'

/**
 * Whether this runtime has watched `key` hold `value` for `ms`; a new value restarts the window.
 * A window not yet due asks for a step when it will be (`wakeAt`), so no timer polls for it.
 */
export function windowDue(
  d: SimPoolDraft,
  key: string,
  value: string | number,
  ms: number,
  wake = true
): boolean {
  let anchor = getAnchor(d.memory.windows, key)
  if (!anchor || anchor.value !== value) {
    anchor = { value, mono: d.now.mono }
    setAnchor(d.memory.windows, key, anchor)
  }
  const due = anchor.mono + ms
  if (d.now.mono >= due) {
    return true
  }
  if (wake) {
    wakeAt(d, due)
  }
  return false
}

/** When this runtime first saw `key` hold `value`. */
export function windowSince(d: SimPoolDraft, key: string, value: string | number): number {
  windowDue(d, key, value, 0, false)
  return getAnchor(d.memory.windows, key)?.mono ?? d.now.mono
}

export function wakeAt(d: SimPoolDraft, mono: number): void {
  d.wakeAt = d.wakeAt === null ? mono : Math.min(d.wakeAt, mono)
}

/** Restart `key` now: the holder acted, whether or not the registry's value moved. */
export function touchWindow(d: SimPoolDraft, key: string, value: string | number): void {
  setAnchor(d.memory.windows, key, { value, mono: d.now.mono })
}

export function dropWindow(d: SimPoolDraft, key: string): void {
  dropAnchor(d.memory.windows, key)
}

export function forgetWindows(d: SimPoolDraft, id: string): void {
  const suffix = `:${id}`
  forEachAnchor(d.memory.windows, (key) => {
    if (key.endsWith(suffix)) {
      dropAnchor(d.memory.windows, key)
    }
  })
}

/**
 * Wall and monotonic time moving apart between two steps means time passed that no rule watched:
 * a sleep (the monotonic clock stops in sleep, see SimClock) or a wall clock step. Every window
 * then restarts. Wall times ahead of now (the clock stepped back) are pulled to now, so nothing
 * reads a negative idle time. Steps may be minutes apart (they come on events and `wakeAt`), so a
 * long gap alone means nothing.
 */
export function observeClock(d: SimPoolDraft): void {
  const last = d.memory.lastTick
  d.memory.lastTick = d.now
  const leap =
    last !== null && Math.abs(d.now.wall - last.wall - (d.now.mono - last.mono)) > SIM_CLOCK_STEP_MS
  if (leap) {
    forEachAnchor(d.memory.windows, (key, anchor) => {
      setAnchor(d.memory.windows, key, { value: anchor.value, mono: d.now.mono })
    })
  }
  const ahead = d.now.wall + SIM_CLOCK_STEP_MS
  for (const lease of d.registry.leases) {
    if (lease.lastActivity > ahead) {
      lease.lastActivity = d.now.wall
    }
    if (lease.takeover && lease.takeover.lastInput > ahead) {
      lease.takeover = { ...lease.takeover, lastInput: d.now.wall }
    }
    if (lease.reservedUntil !== undefined && (leap || lease.reservedUntil > ahead + claimMs())) {
      lease.reservedUntil = d.now.wall + claimMs()
    }
  }
}

export function claimMs(): number {
  return SIM_RESERVATION_CLAIM_S * 1000
}

/** A queue stamp after every waiter's, even when the wall clock stepped back. */
export function queueStamp(d: SimPoolDraft): number {
  const latest = Math.max(0, ...d.registry.leases.map((lease) => lease.queue?.since ?? 0))
  return Math.max(d.now.wall, latest + 1)
}

/** Drop the anchors of leases, devices and tombstones that are gone. */
/**
 * Folds a grown layer of anchors into a new base, dropping those of ids the registry no longer
 * has (lease ids and udids are never reused, so a stale anchor only costs memory until then).
 */
export function foldWindows(d: SimPoolDraft): void {
  if (d.memory.windows.layer.size <= SIM_ANCHOR_LAYER_MAX) {
    return
  }
  const ids = new Set<string>()
  for (const lease of d.registry.leases) {
    ids.add(lease.leaseId)
  }
  for (const ended of d.registry.tombstones ?? []) {
    ids.add(ended.leaseId)
  }
  for (const device of d.registry.devices) {
    ids.add(device.udid)
  }
  d.memory.windows = foldAnchors(d.memory.windows, (key) =>
    ids.has(key.slice(key.indexOf(':') + 1))
  )
}
