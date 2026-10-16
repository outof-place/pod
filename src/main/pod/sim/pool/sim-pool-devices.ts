// Fork-only (Pod): a device's slow work. An op is written into the registry with the device's
// move before its effect runs, so the other runtime sees it and counts it; its outcome comes back
// as a command and moves the device on. An op past its deadline, or one whose runtime exited,
// fails the device and stops holding a slot.
import { simDeviceTransition, type SimDeviceEvent } from '../../../../shared/pod-sim/sim-lifecycle'
import { endLease, leaseOn, returnReservation } from '../leases/sim-lease-records'
import { SIM_OP_DEADLINE_MS, type SimDeviceOp } from './sim-pool-config'
import {
  deviceState,
  moveDevice,
  runtimeKey,
  type SimPoolDevice,
  type SimPoolDraft
} from './sim-pool-draft'
import type { SimOpOutcome, SimOpRef } from './sim-pool-ports'
import { claimMs, dropWindow, forgetWindows, windowDue } from './sim-pool-windows'

const STARTS: Partial<Record<SimDeviceOp, SimDeviceEvent>> = {
  create: 'create',
  clone: 'clone',
  boot: 'boot',
  reset: 'reset',
  release: 'release',
  shutDown: 'shutDown'
}

const FINISHES: Partial<Record<SimDeviceOp, SimDeviceEvent>> = {
  clone: 'cloned',
  prepare: 'prepared',
  boot: 'booted',
  reset: 'resetDone',
  release: 'released',
  shutDown: 'shutDownDone'
}

function beginOp(d: SimPoolDraft, device: SimPoolDevice, kind: SimDeviceOp): SimOpRef {
  const start = STARTS[kind]
  if (start) {
    moveDevice(d, device, start)
  }
  const op: SimOpRef = { kind, by: { ...d.self }, since: d.now.wall }
  device.op = { kind, by: { ...d.self }, since: d.now.wall }
  return op
}

export function startOp(
  d: SimPoolDraft,
  device: SimPoolDevice,
  kind: 'prepare' | 'boot' | 'shutDown' | 'release' | 'delete'
): void {
  const op = beginOp(d, device, kind)
  d.effects.push({ kind, udid: device.udid, op })
}

export function startReset(d: SimPoolDraft, device: SimPoolDevice, leaseId: string): void {
  const op = beginOp(d, device, 'reset')
  d.effects.push({ kind: 'reset', udid: device.udid, op, leaseId })
}

/** A new device's entry (provisional UDID) and op come first, so a crash mid-clone is visible. */
export function startProvision(
  d: SimPoolDraft,
  device: SimPoolDevice,
  golden: SimPoolDevice | undefined
): void {
  if (golden) {
    const op = beginOp(d, device, 'clone')
    d.effects.push({ kind: 'clone', udid: device.udid, op, source: golden.udid, name: device.name })
    return
  }
  const op = beginOp(d, device, 'create')
  d.effects.push({
    kind: 'create',
    udid: device.udid,
    op,
    name: device.name,
    deviceType: device.deviceType,
    runtime: device.runtime
  })
}

function sameOp(a: SimOpRef, b: SimOpRef): boolean {
  return a.kind === b.kind && a.since === b.since && runtimeKey(a.by) === runtimeKey(b.by)
}

/** An op's outcome; one that no longer matches the device's op (failed past its deadline) is ignored. */
export function finishOp(
  d: SimPoolDraft,
  device: SimPoolDevice,
  op: SimOpRef,
  outcome: SimOpOutcome
): void {
  if (!device.op || !sameOp(device.op, op)) {
    return
  }
  delete device.op
  dropWindow(d, `op:${device.udid}`)
  if (!outcome.ok) {
    failDevice(d, device, outcome.message, op.kind)
    return
  }
  if ((op.kind === 'clone' || op.kind === 'create') && outcome.udid) {
    device.udid = outcome.udid
  }
  if (op.kind === 'delete') {
    moveDevice(d, device, 'delete')
    removeDevice(d, device)
    return
  }
  const finish = FINISHES[op.kind]
  if (finish) {
    moveDevice(d, device, finish)
  }
  if (op.kind === 'boot') {
    delete device.failure
  }
}

export function failDevice(
  d: SimPoolDraft,
  device: SimPoolDevice,
  message: string,
  op?: SimDeviceOp
): void {
  delete device.op
  if (simDeviceTransition(deviceState(device), 'fail').ok) {
    moveDevice(d, device, 'fail')
  }
  device.failure = {
    at: d.now.wall,
    message: message.slice(0, 1024),
    ...(op ? { op } : {}),
    count: (device.failure?.count ?? 0) + 1
  }
  const reserved = leaseOn(d, device.udid)
  if (reserved?.state === 'reserved') {
    returnReservation(d, reserved, 'keep')
  }
  // A clone or create that failed never had a UDID simctl knows: the entry goes.
  if (op === 'clone' || op === 'create') {
    moveDevice(d, device, 'lost')
    moveDevice(d, device, 'forget')
    removeDevice(d, device)
  }
}

/** The device left the pool: whoever held it hears `deviceLost`; a reservation keeps its place. */
export function removeDevice(d: SimPoolDraft, device: SimPoolDevice): void {
  d.registry.devices = d.registry.devices.filter((other) => other !== device)
  const lease = leaseOn(d, device.udid)
  if (lease?.state === 'reserved') {
    returnReservation(d, lease, 'keep')
  } else if (lease?.state === 'active' || lease?.state === 'takeover') {
    endLease(d, lease, 'deviceLost', 'deviceLost')
  }
}

/** Ops of exited runtimes, and ops past their deadline, fail their device. */
export function expireOps(d: SimPoolDraft): void {
  const runtimes = d.memory.observation?.runtimes ?? {}
  for (const device of d.registry.devices) {
    const op = device.op
    if (!op) {
      continue
    }
    if (runtimes[runtimeKey(op.by)] === 'exited') {
      failDevice(d, device, `its runtime exited during ${op.kind}`, op.kind)
      continue
    }
    const deadline = SIM_OP_DEADLINE_MS[op.kind]
    if (windowDue(d, `op:${device.udid}`, `${op.kind}:${op.since}:${op.by.pid}`, deadline)) {
      failDevice(d, device, `${op.kind} passed its ${deadline / 1000} s deadline`, op.kind)
    }
  }
}

/** A lease served by an exited runtime is this runtime's now; its windows start afresh. */
export function adoptOrphans(d: SimPoolDraft): void {
  const runtimes = d.memory.observation?.runtimes ?? {}
  for (const lease of d.registry.leases) {
    if (runtimes[runtimeKey(lease.servedBy)] === 'exited') {
      lease.servedBy = { ...d.self }
      if (lease.reservedUntil !== undefined) {
        lease.reservedUntil = d.now.wall + claimMs()
      }
      forgetWindows(d, lease.leaseId)
    }
  }
}
