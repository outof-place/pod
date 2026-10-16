// Fork-only (Pod): what time and liveness do to leases. A takeover goes back 120 s after the
// person's last input; a reservation passes on 60 s after its device was ready unless a call is
// waiting for it; a waiter that stops calling is abandoned. A holder ends by liveness only when it
// reads `exited` (never a person, never during a takeover).
import {
  SIM_TAKEOVER_IDLE_GIVE_BACK_S,
  SIM_WAITER_ABANDON_S
} from '../../../../shared/pod-sim/sim-call-limits'
import {
  deviceState,
  moveLease,
  type SimPoolDraft,
  type SimPoolLease
} from '../pool/sim-pool-draft'
import { claimMs, touchWindow, windowDue } from '../pool/sim-pool-windows'
import { endLease, notifyWaiter, returnReservation, touchActivity } from './sim-lease-records'

export function giveBack(d: SimPoolDraft, lease: SimPoolLease): void {
  moveLease(d, lease, 'giveBack')
  delete lease.takeover
  lease.lastActivity = Math.max(lease.lastActivity, d.now.wall)
  touchActivity(d, lease)
  // A person's own lease ends when they give the device back.
  if (lease.holder.kind === 'human') {
    endLease(d, lease, 'release', 'released')
    return
  }
  notifyWaiter(d, lease)
}

function reservedTimer(d: SimPoolDraft, lease: SimPoolLease): void {
  const device = d.registry.devices.find((candidate) => candidate.udid === lease.udid)
  const ready = device && deviceState(device) === 'ready' && !device.op
  if (!device || (!ready && !device.op)) {
    returnReservation(d, lease, 'keep')
    return
  }
  if (!ready) {
    return
  }
  if (lease.reservedUntil === undefined) {
    lease.reservedUntil = d.now.wall + claimMs()
  }
  if (d.openCalls.has(lease.leaseId)) {
    touchWindow(d, `reserve:${lease.leaseId}`, lease.reservedUntil)
  } else if (windowDue(d, `reserve:${lease.leaseId}`, lease.reservedUntil, claimMs())) {
    returnReservation(d, lease, 'back')
  }
}

export function runLeaseTimers(d: SimPoolDraft): void {
  for (const lease of d.registry.leases) {
    if (lease.state === 'takeover' && lease.takeover) {
      const ms = SIM_TAKEOVER_IDLE_GIVE_BACK_S * 1000
      if (windowDue(d, `input:${lease.leaseId}`, lease.takeover.lastInput, ms)) {
        giveBack(d, lease)
      }
    } else if (lease.state === 'reserved') {
      reservedTimer(d, lease)
    } else if (lease.state === 'waiting') {
      if (d.openCalls.has(lease.leaseId)) {
        touchActivity(d, lease)
      }
      if (windowDue(d, `wait:${lease.leaseId}`, lease.lastActivity, SIM_WAITER_ABANDON_S * 1000)) {
        endLease(d, lease, 'abandon', 'abandoned')
      }
    }
  }
}

/** Only `exited` ends a lease: loss of contact (`unverifiable`) is never death. */
export function applyLiveness(d: SimPoolDraft): void {
  const verdicts = d.memory.observation?.liveness ?? {}
  for (const lease of d.registry.leases) {
    if (verdicts[lease.leaseId] !== 'exited' || lease.holder.kind === 'human') {
      continue
    }
    if (lease.state === 'takeover') {
      // The person keeps driving; the lease ends at the first check after give-back.
      moveLease(d, lease, 'holderExited')
    } else {
      endLease(d, lease, 'holderExited', 'holderExited')
    }
  }
}
