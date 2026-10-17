// Fork-only (Pod): what a holder is told about its lease, its device and its place. Every refusal
// is one the contract words (sim-refusals.ts); an ended lease answers why it ended.
import { SIM_WAITING_LIST_MAX } from '../../../../shared/pod-sim/sim-call-limits'
import type {
  SimLeaseCaller,
  SimGateRefusal,
  SimLeaseAnswer,
  SimWaitReason
} from '../pool/sim-pool-commands'
import {
  deviceState,
  type SimPoolDevice,
  type SimPoolDraft,
  type SimPoolLease,
  type SimPoolTombstone
} from '../pool/sim-pool-draft'
import { unlistedBooted } from '../pool/sim-pool-reconcile'
import { holderBase, tombstone } from './sim-lease-records'
import { holdersOf, queueOf, wantedClass } from './sim-lease-queue'

function busyState(
  device: SimPoolDevice
): 'booting' | 'preparing' | 'resetting' | 'releasing' | null {
  switch (device.op?.kind) {
    case 'boot':
      return 'booting'
    case 'prepare':
      return 'preparing'
    case 'reset':
      return 'resetting'
    case 'release':
      return 'releasing'
    // A shutdown, delete, clone or create ends the device's use: the verb hears device_down.
    case 'shutDown':
    case 'delete':
    case 'clone':
    case 'create':
    case undefined:
      return null
  }
}

/** Why the device of a live lease cannot take a verb now, or null when it can. */
export function deviceRefusal(device: SimPoolDevice | undefined): SimGateRefusal | null {
  const busy = device ? busyState(device) : null
  if (busy) {
    return { code: 'device_busy', state: busy }
  }
  const state = device ? deviceState(device) : 'lost'
  // A failed reset left it erased: down until the pool has reset it again (sim-pool-unheld.ts).
  const erased = device?.failure?.op === 'reset'
  if (device && !device.op && !erased && (state === 'leased' || state === 'ready')) {
    return null
  }
  return {
    code: 'device_down',
    device: device?.name ?? 'the simulator',
    state: device?.failure ? 'failed' : 'lost',
    ...(device?.failure ? { problem: device.failure.message } : {})
  }
}

/** What a call from a key with no live lease hears: why its last lease ended, else not_leased. */
export function endedRefusal(
  d: SimPoolDraft,
  caller: SimLeaseCaller,
  verb: string
): SimGateRefusal {
  const ended: SimPoolTombstone | undefined = tombstone(d, caller.key)
  const reason = ended?.ended.reason
  if (reason === 'buildFailed' && ended?.ended.buildId) {
    return { code: 'build_failed', buildId: ended.ended.buildId }
  }
  if (
    reason === 'idleForWaiter' ||
    reason === 'memoryBrake' ||
    reason === 'abandoned' ||
    reason === 'deviceLost' ||
    reason === 'worktreeRemoved'
  ) {
    return { code: 'lease_expired', reason }
  }
  const base = holderBase(caller.holder)
  const elsewhere = d.registry.leases
    .filter((lease) => lease.udid && holderBase(lease.holder) === base)
    .map((lease) => ({
      worktreeRoot: lease.worktreeRoot,
      device: d.registry.devices.find((device) => device.udid === lease.udid)?.name ?? 'a simulator'
    }))
    .slice(0, SIM_WAITING_LIST_MAX)
  return {
    code: 'not_leased',
    worktreeRoot: caller.worktreeRoot,
    verb,
    ...(elsewhere.length > 0 ? { heldElsewhere: elsewhere } : {})
  }
}

export function queuePosition(d: SimPoolDraft, lease: SimPoolLease): number {
  if (lease.state !== 'waiting') {
    return 1
  }
  return queueOf(d, wantedClass(lease)).indexOf(lease) + 1
}

export function leaseAnswer(d: SimPoolDraft, lease: SimPoolLease): SimLeaseAnswer {
  const device = d.registry.devices.find((candidate) => candidate.udid === lease.udid)
  if (lease.state === 'takeover') {
    return { status: 'heldByHuman', lease }
  }
  if (lease.state === 'active') {
    const refusal = deviceRefusal(device)
    if (refusal) {
      return { status: 'refused', refusal }
    }
    if (device) {
      return { status: 'ready', lease, device }
    }
  }
  const deviceClass = wantedClass(lease)
  const queue = lease.state === 'waiting' ? queueOf(d, deviceClass) : []
  const ahead = queue.slice(0, Math.max(0, queue.indexOf(lease))).map((other) => other.holder)
  const holders = holdersOf(d, deviceClass)
  const waitingFor: SimWaitReason =
    lease.state === 'reserved' ? 'device' : (lease.queue?.waitingFor ?? 'slot')
  const stalled = d.stalls.get(lease.leaseId)
  const unlisted = unlistedBooted(d)
    .slice(0, SIM_WAITING_LIST_MAX)
    .map((device) => ({ udid: device.udid, name: device.name }))
  return {
    status: 'waiting',
    lease,
    position: queuePosition(d, lease),
    waitingFor,
    ...(stalled && lease.state === 'waiting' ? { stalled } : {}),
    ahead: ahead.slice(0, SIM_WAITING_LIST_MAX),
    aheadOmitted: Math.max(0, ahead.length - SIM_WAITING_LIST_MAX),
    holders: holders.slice(0, SIM_WAITING_LIST_MAX),
    holdersOmitted: Math.max(0, holders.length - SIM_WAITING_LIST_MAX),
    ...(unlisted.length > 0 ? { unlisted } : {})
  }
}
