// Fork-only (Pod): an idle lease (no sim call, and no outside process with its UDID in argv, for
// the idle window) is revoked only when that helps someone: a waiter that can use the device and
// gets no other (`idleForWaiter`, the device goes to it), or claude-acc's brake at `tight` or
// worse (`memoryBrake`, the device shuts down unless a waiter takes it). Never a takeover, never a
// lease whose device is busy with an op.
import { armBrakeHold, brakeIsTight } from '../pool/sim-pool-capacity'
import type { SimPoolDraft, SimPoolLease } from '../pool/sim-pool-draft'
import { touchWindow, windowDue, windowSince } from '../pool/sim-pool-windows'
import { endLease } from './sim-lease-records'
import { deviceFits, queueOf, waitingClasses } from './sim-lease-queue'

const HELPED_BY_REVOKING = new Set(['slot', 'brake', 'device'])

function idleLeases(d: SimPoolDraft, watching: boolean): SimPoolLease[] {
  const used = new Set(d.memory.observation?.externalUse ?? [])
  const idle: SimPoolLease[] = []
  for (const lease of d.registry.leases) {
    const device = d.registry.devices.find((candidate) => candidate.udid === lease.udid)
    if (lease.state !== 'active' || !device || device.op) {
      continue
    }
    const key = `idle:${lease.leaseId}`
    if (used.has(device.udid)) {
      touchWindow(d, key, lease.lastActivity)
    } else if (windowDue(d, key, lease.lastActivity, d.config.idleMs, watching)) {
      idle.push(lease)
    }
  }
  return idle.sort(
    (a, b) =>
      windowSince(d, `idle:${a.leaseId}`, a.lastActivity) -
      windowSince(d, `idle:${b.leaseId}`, b.lastActivity)
  )
}

export function revokeIdle(d: SimPoolDraft): void {
  const tight = brakeIsTight(d)
  const waiters = waitingClasses(d)
    .flatMap((deviceClass) => queueOf(d, deviceClass))
    .filter((lease) => HELPED_BY_REVOKING.has(d.unserved.get(lease.leaseId) ?? ''))
  if (waiters.length === 0 && !tight) {
    // Nobody to help: watch the idle windows without asking for a step when they fall due.
    idleLeases(d, false)
    return
  }
  const idle = idleLeases(d, true)
  for (const waiter of waiters) {
    const victim = idle.find((lease) => {
      const device = d.registry.devices.find((candidate) => candidate.udid === lease.udid)
      return device !== undefined && deviceFits(device, waiter)
    })
    if (victim) {
      idle.splice(idle.indexOf(victim), 1)
      endLease(d, victim, 'revoke', 'idleForWaiter')
    }
  }
  if (!tight) {
    return
  }
  for (const lease of idle) {
    if (lease.udid) {
      d.brakeEnded.add(lease.udid)
    }
    endLease(d, lease, 'revoke', 'memoryBrake')
    armBrakeHold(d)
  }
}
