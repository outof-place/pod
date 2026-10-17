// Fork-only (Pod): an agent's calls. `lease` is idempotent per key (two subagents of one holder
// get one lease, one id, one place) and joins a new lease at the back; a call is activity and
// makes the runtime it reached the lease's server. Each handler edits the draft and returns a
// function that answers once the step has settled (a free device may be claimed meanwhile).
import type { SimLeaseCaller, SimLeaseRequest, SimPoolAnswer } from '../pool/sim-pool-commands'
import { startReset } from '../pool/sim-pool-devices'
import {
  deviceState,
  moveDevice,
  type SimPoolDraft,
  type SimPoolLease
} from '../pool/sim-pool-draft'
import { queueStamp } from '../pool/sim-pool-windows'
import { deviceRefusal, endedRefusal, leaseAnswer, queuePosition } from './sim-lease-answers'
import { endLease, liveLease, tombstone, touchActivity } from './sim-lease-records'

export type SimAnswerLater = () => SimPoolAnswer

/** The holder's call reached this runtime: it serves the lease and resolved the holder. */
function serveHere(d: SimPoolDraft, lease: SimPoolLease): void {
  lease.servedBy = { ...d.self }
  lease.resolvedBy = { ...d.self }
  touchActivity(d, lease)
  d.calling = lease.leaseId
  d.openCalls.add(lease.leaseId)
}

export function leaseCall(d: SimPoolDraft, request: SimLeaseRequest): SimAnswerLater {
  let lease = liveLease(d, request.key)
  if (!lease) {
    // A new lease is a new start: the old one's tombstone has said its piece.
    const ended = tombstone(d, request.key)
    if (ended) {
      d.registry.tombstones = d.registry.tombstones?.filter((other) => other !== ended)
    }
    lease = {
      leaseId: d.ids.leaseId(),
      key: request.key,
      state: 'waiting',
      holder: request.holder,
      worktreeRoot: request.worktreeRoot,
      ...(request.worktreeId ? { worktreeId: request.worktreeId } : {}),
      ...(request.app ? { app: request.app } : {}),
      since: d.now.wall,
      lastActivity: d.now.wall,
      queue: {
        position: 1,
        since: queueStamp(d),
        waitingFor: 'slot',
        ...(request.buildId ? { buildId: request.buildId } : {})
      },
      wants: request.wants ?? { deviceClass: 'iphone' },
      servedBy: { ...d.self }
    }
    d.registry.leases.push(lease)
  }
  serveHere(d, lease)
  const mine = lease
  return () => ({ kind: 'lease', answer: leaseAnswer(d, mine) })
}

/** `wait --mine`: never starts a lease. */
export function waitMineCall(d: SimPoolDraft, caller: SimLeaseCaller): SimAnswerLater {
  const lease = liveLease(d, caller.key)
  if (!lease) {
    return () => ({
      kind: 'lease',
      answer: { status: 'refused', refusal: endedRefusal(d, caller, 'wait --mine') }
    })
  }
  serveHere(d, lease)
  return () => ({ kind: 'lease', answer: leaseAnswer(d, lease) })
}

/** Never refuses: a lease already gone answers `released: false` and why it ended. */
export function releaseCall(d: SimPoolDraft, caller: SimLeaseCaller): SimAnswerLater {
  const lease = liveLease(d, caller.key)
  if (lease) {
    endLease(d, lease, 'release', 'released')
    return () => ({ kind: 'release', answer: { released: true, leaseId: lease.leaseId } })
  }
  const ended = tombstone(d, caller.key)
  return () => ({
    kind: 'release',
    answer: ended
      ? {
          released: false,
          leaseId: ended.leaseId,
          ended: { at: ended.ended.at, reason: ended.ended.reason }
        }
      : { released: false }
  })
}

/**
 * Whether a device verb may run for this caller. A person driving holds input (`held_by_human`)
 * but reads still work.
 */
export function verbCall(
  d: SimPoolDraft,
  caller: SimLeaseCaller,
  verb: string,
  access: 'read' | 'input'
): SimAnswerLater {
  const lease = liveLease(d, caller.key)
  if (!lease) {
    return () => ({
      kind: 'verb',
      answer: { allow: false, refusal: endedRefusal(d, caller, verb) }
    })
  }
  touchActivity(d, lease)
  return () => ({ kind: 'verb', answer: verbAnswer(d, lease, access) })
}

function verbAnswer(d: SimPoolDraft, lease: SimPoolLease, access: 'read' | 'input') {
  if (lease.state === 'waiting' || lease.state === 'reserved') {
    return {
      allow: false as const,
      refusal: { code: 'lease_waiting' as const, position: queuePosition(d, lease) }
    }
  }
  if (lease.state === 'takeover' && access === 'input') {
    return { allow: false as const, refusal: { code: 'held_by_human' as const } }
  }
  const device = d.registry.devices.find((candidate) => candidate.udid === lease.udid)
  const refusal = deviceRefusal(device)
  if (refusal) {
    return { allow: false as const, refusal }
  }
  if (!device) {
    const gone = { code: 'device_down' as const, device: 'the simulator', state: 'lost' as const }
    return { allow: false as const, refusal: gone }
  }
  return { allow: true as const, lease, udid: device.udid }
}

/**
 * `reset device` keeps the UDID and the slot (shut down, erase, re-slim, boot): not a new boot,
 * so the brake does not gate it. `reset app` neither erases nor boots.
 */
export function resetCall(
  d: SimPoolDraft,
  caller: SimLeaseCaller,
  scope: 'app' | 'device'
): SimAnswerLater {
  const lease = liveLease(d, caller.key)
  if (!lease) {
    return () => ({
      kind: 'verb',
      answer: { allow: false, refusal: endedRefusal(d, caller, 'reset') }
    })
  }
  touchActivity(d, lease)
  const answer = verbAnswer(d, lease, 'input')
  if (answer.allow) {
    const device = d.registry.devices.find((candidate) => candidate.udid === answer.udid)
    if (scope === 'app') {
      d.effects.push({ kind: 'resetApp', udid: answer.udid, leaseId: lease.leaseId })
    } else if (device) {
      if (deviceState(device) === 'ready') {
        moveDevice(d, device, 'lease')
      }
      startReset(d, device, lease)
    }
  }
  return () => ({ kind: 'verb', answer })
}
