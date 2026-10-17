// Fork-only (Pod): who gets which device. Each class's head waiter gets a free device of its kind,
// a booted one first (no slot needed) and its own worktree's among equals; a shut-down one boots
// only through the gate. A call waiting for a reserved device claims it the moment it is ready.
// When no device of the class is free and a slot nobody holds is, the pool makes one (a clone of
// the golden device, else a fresh one) for each waiter it would fit, up to its per-class limit; a
// waiter for a model the pool neither has nor makes gets nothing made and is told so.
import { simDeviceIsFree, type SimDeviceState } from '../../../../shared/pod-sim/sim-lifecycle'
import type { SimDeviceClass } from '../../../../shared/pod-sim/sim-pool-snapshot'
import { leaseOn, notifyWaiter } from '../leases/sim-lease-records'
import {
  canTakeDevice,
  deviceClassOf,
  deviceFits,
  queueOf,
  waitingClasses
} from '../leases/sim-lease-queue'
import { bootGate, provisionGate, slimGate, type SimBootGate } from './sim-pool-capacity'
import { slimProfileOf, startOp, startPrepare, startProvision } from './sim-pool-devices'
import {
  deviceState,
  moveDevice,
  moveLease,
  type SimPoolDevice,
  type SimPoolDraft,
  type SimPoolLease
} from './sim-pool-draft'
import { trustedListing } from './sim-pool-reconcile'
import { claimMs, dropWindow, touchWindow } from './sim-pool-windows'

function hasState(device: SimPoolDevice): device is SimPoolDevice & { state: SimDeviceState } {
  return device.state !== undefined
}

export function isFree(d: SimPoolDraft, device: SimPoolDevice): boolean {
  const stated = hasState(device) ? device : { ...device, state: deviceState(device) }
  return !device.op && simDeviceIsFree(stated, d.registry.leases)
}

function rank(device: SimPoolDevice, lease: SimPoolLease): number {
  const warm = deviceState(device) === 'ready' ? 0 : 2
  return warm + (device.affinity === lease.worktreeRoot ? 0 : 1)
}

function reserve(d: SimPoolDraft, lease: SimPoolLease, device: SimPoolDevice): void {
  moveLease(d, lease, 'reserve')
  lease.udid = device.udid
  if (deviceState(device) === 'ready') {
    lease.reservedUntil = d.now.wall + claimMs()
    touchWindow(d, `reserve:${lease.leaseId}`, lease.reservedUntil)
  }
}

export function claim(d: SimPoolDraft, lease: SimPoolLease, device: SimPoolDevice): void {
  moveLease(d, lease, 'claim')
  delete lease.reservedUntil
  dropWindow(d, `reserve:${lease.leaseId}`)
  delete lease.queue
  moveDevice(d, device, 'lease')
  device.affinity = lease.worktreeRoot
  notifyWaiter(d, lease)
}

function claimOpenCalls(d: SimPoolDraft): void {
  for (const lease of d.registry.leases) {
    if (lease.state !== 'reserved' || !d.openCalls.has(lease.leaseId)) {
      continue
    }
    const device = d.registry.devices.find((candidate) => candidate.udid === lease.udid)
    if (device && !device.op && deviceState(device) === 'ready') {
      claim(d, lease, device)
    }
  }
}

/** A held device that went down outside Pod comes back for its lease when a slot allows. */
function bootHeldDevices(d: SimPoolDraft): void {
  for (const device of d.registry.devices) {
    const lease = leaseOn(d, device.udid)
    if (
      lease &&
      lease.state !== 'reserved' &&
      !device.op &&
      deviceState(device) === 'shutdown' &&
      bootGate(d) === 'open'
    ) {
      startOp(d, device, 'boot')
    }
  }
}

/** The free device a waiter is best given: warm first, its own worktree's among equals. */
function bestFor(free: readonly SimPoolDevice[], waiter: SimPoolLease): SimPoolDevice | undefined {
  let best: SimPoolDevice | undefined
  for (const device of free) {
    if (deviceFits(device, waiter) && (!best || rank(device, waiter) < rank(best, waiter))) {
      best = device
    }
  }
  return best
}

/** What the pool makes for a waiter of this class, if that would fit what it asked for. */
function madeFor(d: SimPoolDraft, deviceClass: SimDeviceClass, waiter: SimPoolLease) {
  const kind = d.config.deviceTypes[deviceClass]
  const model = waiter.wants?.deviceType
  return kind && (!model || model === kind.deviceType) ? kind : undefined
}

/** Whether the pool has a device the waiter could ever take (held, down or still being made). */
function poolHasFit(d: SimPoolDraft, waiter: SimPoolLease): boolean {
  return d.registry.devices.some((device) => device.role === 'pool' && deviceFits(device, waiter))
}

/** Serves the class's waiters from free devices; returns those a new device would serve. */
function serveClass(
  d: SimPoolDraft,
  deviceClass: SimDeviceClass,
  effects: boolean
): SimPoolLease[] {
  const needy: SimPoolLease[] = []
  const free = d.registry.devices.filter((device) => isFree(d, device))
  // Only a boot started here takes a slot, so the gate is read again only after one.
  let gate = bootGate(d)
  for (const waiter of queueOf(d, deviceClass)) {
    if (!canTakeDevice(waiter)) {
      continue
    }
    const pick = bestFor(free, waiter)
    if (!pick) {
      const makeable = madeFor(d, deviceClass, waiter) !== undefined
      if (!makeable && !poolHasFit(d, waiter)) {
        d.unserved.set(waiter.leaseId, 'unmakeable')
        continue
      }
      d.unserved.set(waiter.leaseId, gate === 'open' ? 'device' : gate)
      if (makeable && gate === 'open') {
        needy.push(waiter)
      }
    } else if (deviceState(pick) === 'ready') {
      reserve(d, waiter, pick)
      free.splice(free.indexOf(pick), 1)
    } else if (!effects) {
      continue
    } else if (gate === 'open') {
      reserve(d, waiter, pick)
      startOp(d, pick, 'boot')
      free.splice(free.indexOf(pick), 1)
      gate = bootGate(d)
    } else {
      d.unserved.set(waiter.leaseId, gate)
    }
  }
  return needy
}

function nextName(d: SimPoolDraft): string {
  const taken = new Set(d.registry.devices.map((device) => device.name))
  let n = 1
  while (taken.has(`${d.config.namePrefix}Pod-${n}`)) {
    n += 1
  }
  return `${d.config.namePrefix}Pod-${n}`
}

function makeDevice(d: SimPoolDraft, kind: { deviceType: string; runtime: string }): void {
  const golden = d.registry.devices.find(
    (device) =>
      device.role === 'golden' &&
      device.deviceType === kind.deviceType &&
      device.runtime === kind.runtime &&
      !device.op &&
      deviceState(device) === 'shutdown'
  )
  const device: SimPoolDevice = {
    udid: d.ids.deviceId(),
    name: nextName(d),
    role: 'pool',
    deviceType: kind.deviceType,
    runtime: kind.runtime,
    createdAt: d.now.wall,
    state: 'absent',
    ...(golden ? { clonedFrom: golden.udid } : {})
  }
  d.registry.devices.push(device)
  startProvision(d, device, golden)
}

/**
 * One new device per waiter no free device serves, counting those already being made, while a
 * slot nobody holds is open (a clone in flight holds the one it will need) and the class is under
 * its limit. Waiters past what is being made wait for what stopped it.
 */
function provision(d: SimPoolDraft, deviceClass: SimDeviceClass, needy: SimPoolLease[]): void {
  const kind = d.config.deviceTypes[deviceClass]
  if (!kind || needy.length === 0) {
    return
  }
  const ofClass = d.registry.devices.filter(
    (device) => device.role === 'pool' && deviceClassOf(device.deviceType) === deviceClass
  )
  let making = ofClass.filter((device) => {
    const state = deviceState(device)
    return state === 'cloning' || state === 'preparing' || state === 'absent'
  }).length
  let count = ofClass.length
  let gate: SimBootGate = provisionGate(d)
  while (needy.length > making && count < d.config.maxDevicesPerClass && gate === 'open') {
    makeDevice(d, kind)
    making += 1
    count += 1
    gate = provisionGate(d)
  }
  needy.forEach((waiter, index) => {
    const stopped = gate === 'open' ? 'device' : gate
    d.unserved.set(waiter.leaseId, index < making ? 'creating' : stopped)
  })
}

/** The waiter a new device is likely for: the first of its class it fits. */
function likelyTaker(d: SimPoolDraft, device: SimPoolDevice): SimPoolLease | undefined {
  if (device.role !== 'pool') {
    return undefined
  }
  return queueOf(d, deviceClassOf(device.deviceType)).find(
    (waiter) => canTakeDevice(waiter) && deviceFits(device, waiter)
  )
}

/** Slim a cloned or created device once what is booted leaves it room (its slot is held). */
function prepareDevices(d: SimPoolDraft): void {
  for (const device of d.registry.devices) {
    if (!device.op && deviceState(device) === 'preparing' && slimGate(d) === 'open') {
      startPrepare(d, device, slimProfileOf(likelyTaker(d, device)))
    }
  }
}

export function allocate(d: SimPoolDraft): void {
  const effects = trustedListing(d) !== null
  claimOpenCalls(d)
  if (effects) {
    bootHeldDevices(d)
  }
  const needy = new Map<SimDeviceClass, SimPoolLease[]>()
  for (const deviceClass of waitingClasses(d)) {
    needy.set(deviceClass, serveClass(d, deviceClass, effects))
  }
  claimOpenCalls(d)
  if (!effects) {
    return
  }
  prepareDevices(d)
  for (const [deviceClass, waiters] of needy) {
    provision(d, deviceClass, waiters)
  }
}
