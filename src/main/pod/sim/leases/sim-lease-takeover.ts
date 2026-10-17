// Fork-only (Pod): Filip takes a device over and gives it back. He may take an agent's active
// lease (its input waits, its reads work) or a free booted device (a `human` holder lease), never
// a device reserved for a waiter. Liveness never ends a takeover; it goes back on its own 120 s
// after his last input, with or without a tab attached.
import { SIM_HOLDER_NAME_PATTERN, simLeaseKey } from '../../../../shared/pod-sim/sim-holder'
import { claim, isFree } from '../pool/sim-pool-allocate'
import type { SimAnswerLater } from './sim-lease-calls'
import { SIM_ACTIVITY_WRITE_MS } from '../pool/sim-pool-config'
import {
  deviceState,
  moveLease,
  type SimPoolDraft,
  type SimPoolLease
} from '../pool/sim-pool-draft'
import { touchWindow } from '../pool/sim-pool-windows'
import { leaseById, leaseOn, liveLease, tombstone } from './sim-lease-records'
import { giveBack } from './sim-lease-timers'

function startTakeover(d: SimPoolDraft, lease: SimPoolLease): void {
  moveLease(d, lease, 'takeover')
  lease.takeover = { since: d.now.wall, lastInput: d.now.wall }
  touchWindow(d, `input:${lease.leaseId}`, d.now.wall)
}

export function takeoverCall(d: SimPoolDraft, leaseId: string): SimAnswerLater {
  const lease = leaseById(d, leaseId)
  const device = d.registry.devices.find((candidate) => candidate.udid === lease?.udid)
  const refuse =
    (reason: 'reserved' | 'waiting' | 'leaseEnded' | 'deviceBusy' | 'deviceNotBooted') =>
    (): ReturnType<SimAnswerLater> => ({ kind: 'takeover', answer: { ok: false, reason } })
  if (!lease) {
    return refuse('leaseEnded')
  }
  if (lease.state === 'reserved' || lease.state === 'waiting') {
    return refuse(lease.state)
  }
  if (lease.state === 'active') {
    if (!device || device.op) {
      return refuse(device ? 'deviceBusy' : 'deviceNotBooted')
    }
    if (deviceState(device) !== 'leased') {
      return refuse('deviceNotBooted')
    }
    startTakeover(d, lease)
  }
  return () => ({ kind: 'takeover', answer: { ok: true, lease } })
}

/** A free booted device taken by a person: a lease of their own, born driven. */
export function takeoverDeviceCall(
  d: SimPoolDraft,
  udid: string,
  person: string,
  worktreeRoot: string
): SimAnswerLater {
  const device = d.registry.devices.find((candidate) => candidate.udid === udid)
  const held = leaseOn(d, udid)
  const refuse =
    (reason: 'reserved' | 'leased' | 'deviceNotBooted' | 'alreadyDriving', leaseId?: string) =>
    (): ReturnType<SimAnswerLater> => ({
      kind: 'takeover',
      answer: { ok: false, reason, ...(leaseId ? { leaseId } : {}) }
    })
  if (held) {
    return refuse(held.state === 'reserved' ? 'reserved' : 'leased', held.leaseId)
  }
  const name = SIM_HOLDER_NAME_PATTERN.test(person) ? person : 'person'
  const key = simLeaseKey(`human:${name}`, worktreeRoot)
  if (liveLease(d, key)) {
    return refuse('alreadyDriving')
  }
  if (!device || !isFree(d, device) || deviceState(device) !== 'ready') {
    return refuse('deviceNotBooted')
  }
  const ended = tombstone(d, key)
  if (ended) {
    d.registry.tombstones = d.registry.tombstones?.filter((other) => other !== ended)
  }
  const lease: SimPoolLease = {
    leaseId: d.ids.leaseId(),
    key,
    state: 'waiting',
    holder: { kind: 'human', id: `human:${name}`, name },
    worktreeRoot,
    since: d.now.wall,
    lastActivity: d.now.wall,
    servedBy: { ...d.self },
    resolvedBy: { ...d.self }
  }
  d.registry.leases.push(lease)
  moveLease(d, lease, 'reserve')
  lease.udid = udid
  claim(d, lease, device)
  startTakeover(d, lease)
  return () => ({ kind: 'takeover', answer: { ok: true, lease } })
}

export function humanInputCall(d: SimPoolDraft, leaseId: string): void {
  const lease = leaseById(d, leaseId)
  if (lease?.state !== 'takeover' || !lease.takeover) {
    return
  }
  if (d.now.wall - lease.takeover.lastInput >= SIM_ACTIVITY_WRITE_MS) {
    lease.takeover = { ...lease.takeover, lastInput: d.now.wall }
  }
  touchWindow(d, `input:${lease.leaseId}`, lease.takeover.lastInput)
}

export function giveBackCall(d: SimPoolDraft, leaseId: string): void {
  const lease = leaseById(d, leaseId)
  if (lease?.state === 'takeover') {
    giveBack(d, lease)
  }
}
