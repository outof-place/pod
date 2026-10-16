// Fork-only (Pod): finding, touching and ending leases in a pool draft. An ended lease leaves the
// live list for the tombstones, so its holder's late call (from either runtime, after a restart
// too) still hears why it ended.
import type { SimHolder } from '../../../../shared/pod-sim/sim-holder'
import type { SimLeaseEvent } from '../../../../shared/pod-sim/sim-lifecycle'
import type { SimLeaseEndReason } from '../../../../shared/pod-sim/sim-pool-snapshot'
import {
  SIM_ACTIVITY_WRITE_MS,
  SIM_TOMBSTONE_KEEP_MS,
  SIM_TOMBSTONE_MAX
} from '../pool/sim-pool-config'
import {
  moveLease,
  type SimPoolDraft,
  type SimPoolLease,
  type SimPoolTombstone
} from '../pool/sim-pool-draft'
import { forgetWindows, queueStamp, touchWindow, windowDue } from '../pool/sim-pool-windows'

export function liveLease(d: SimPoolDraft, key: string): SimPoolLease | undefined {
  return d.registry.leases.find((lease) => lease.key === key)
}

export function leaseById(d: SimPoolDraft, leaseId: string): SimPoolLease | undefined {
  return d.registry.leases.find((lease) => lease.leaseId === leaseId)
}

export function tombstone(d: SimPoolDraft, key: string): SimPoolTombstone | undefined {
  return d.registry.tombstones?.find((ended) => ended.key === key)
}

/** The lease holding or reserving a device: at most one, since a device has one holder. */
export function leaseOn(d: SimPoolDraft, udid: string): SimPoolLease | undefined {
  return d.registry.leases.find((lease) => lease.udid === udid)
}

/** The holder without `/<name>`: parallel flows of one agent are one holder for fairness. */
export function holderBase(holder: SimHolder): string {
  const slash = holder.id.indexOf('/')
  return slash === -1 ? holder.id : holder.id.slice(0, slash)
}

/** Any call is activity; the file hears of it at most every SIM_ACTIVITY_WRITE_MS. */
export function touchActivity(d: SimPoolDraft, lease: SimPoolLease): void {
  if (d.now.wall - lease.lastActivity >= SIM_ACTIVITY_WRITE_MS || lease.lastActivity > d.now.wall) {
    lease.lastActivity = d.now.wall
  }
  touchWindow(d, `idle:${lease.leaseId}`, lease.lastActivity)
  touchWindow(d, `wait:${lease.leaseId}`, lease.lastActivity)
}

export function notifyWaiter(d: SimPoolDraft, lease: SimPoolLease): void {
  if (d.openCalls.has(lease.leaseId) && d.calling !== lease.leaseId) {
    d.effects.push({ kind: 'notifyWaiter', leaseId: lease.leaseId })
  }
}

export function endLease(
  d: SimPoolDraft,
  lease: SimPoolLease,
  event: SimLeaseEvent,
  reason: SimLeaseEndReason,
  buildId?: string
): void {
  moveLease(d, lease, event)
  if (lease.state !== 'expired' && lease.state !== 'released') {
    return
  }
  d.registry.leases = d.registry.leases.filter((live) => live !== lease)
  forgetWindows(d, lease.leaseId)
  const ended: SimPoolTombstone = {
    ...lease,
    state: lease.state,
    ended: { at: d.now.wall, reason, ...(buildId ? { buildId } : {}) }
  }
  const kept = (d.registry.tombstones ?? []).filter((old) => old.key !== lease.key)
  d.registry.tombstones = [...kept, ended].slice(-SIM_TOMBSTONE_MAX)
  // Its day starts now; polls (pruneTombstones) only read it.
  touchWindow(d, `tomb:${ended.leaseId}`, ended.ended.at)
  notifyWaiter(d, lease)
}

/**
 * Give the reserved device back to the pool. A lapse (unclaimed for 60 s) sends the waiter to the
 * back of the queue; a device that failed or went away under it keeps its place.
 */
export function returnReservation(
  d: SimPoolDraft,
  lease: SimPoolLease,
  place: 'back' | 'keep'
): void {
  moveLease(d, lease, 'lapse')
  delete lease.udid
  delete lease.reservedUntil
  const since = place === 'back' || !lease.queue ? queueStamp(d) : lease.queue.since
  lease.queue = { position: lease.queue?.position ?? 1, since, waitingFor: 'device' }
  forgetWindows(d, lease.leaseId)
  touchActivity(d, lease)
}

/** Tombstones live 24 hours of observed time, or until their key leases again. */
export function pruneTombstones(d: SimPoolDraft): void {
  const all = d.registry.tombstones
  if (!all || all.length === 0) {
    return
  }
  const liveKeys = new Set<string>()
  for (const lease of d.registry.leases) {
    liveKeys.add(lease.key)
  }
  const kept = (ended: SimPoolTombstone): boolean =>
    !liveKeys.has(ended.key) &&
    !windowDue(d, `tomb:${ended.leaseId}`, ended.ended.at, SIM_TOMBSTONE_KEEP_MS, false)
  // The array is replaced only when one goes (copy on write: the input's array is shared).
  let gone = 0
  for (const ended of all) {
    gone += kept(ended) ? 0 : 1
  }
  if (gone > 0 || all.length > SIM_TOMBSTONE_MAX) {
    d.registry.tombstones = all.filter(kept).slice(-SIM_TOMBSTONE_MAX)
  }
}
