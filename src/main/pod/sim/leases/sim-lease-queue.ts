// Fork-only (Pod): one Mac-wide queue per device class. Waiters are served oldest `queue.since`
// first, except that a holder already holding a device waits behind holders holding none. A
// waiter whose dev client still builds keeps its place and is skipped, never blocking the rest.
import type { SimHolder } from '../../../../shared/pod-sim/sim-holder'
import type { SimDeviceClass } from '../../../../shared/pod-sim/sim-pool-snapshot'
import type { SimPoolDevice, SimPoolDraft, SimPoolLease } from '../pool/sim-pool-draft'
import { holderBase } from './sim-lease-records'

export type SimWaitReason = 'slot' | 'brake' | 'build' | 'device'

export function deviceClassOf(deviceType: string): SimDeviceClass {
  return /^ipad/i.test(deviceType) ? 'ipad' : 'iphone'
}

export function wantedClass(lease: SimPoolLease): SimDeviceClass {
  return lease.wants?.deviceClass ?? 'iphone'
}

/** Whether a device is of the class (and model, when named) the lease asked for. */
export function deviceFits(device: SimPoolDevice, lease: SimPoolLease): boolean {
  const wants = lease.wants
  return (
    deviceClassOf(device.deviceType) === wantedClass(lease) &&
    (!wants?.deviceType || wants.deviceType === device.deviceType)
  )
}

/** A waiter that can take a device now: its dev client is not still building. */
export function canTakeDevice(lease: SimPoolLease): boolean {
  return lease.state === 'waiting' && !lease.queue?.buildId
}

/** Oldest place first; lease ids (code-unit order, the same in every locale) break ties. */
function byArrival(a: SimPoolLease, b: SimPoolLease): number {
  const since = (a.queue?.since ?? a.since) - (b.queue?.since ?? b.since)
  return since || (a.leaseId < b.leaseId ? -1 : a.leaseId > b.leaseId ? 1 : 0)
}

/** The waiters of one class in the order they are served. */
export function queueOf(d: SimPoolDraft, deviceClass: SimDeviceClass): SimPoolLease[] {
  const holding = new Set<string>()
  for (const lease of d.registry.leases) {
    if (lease.state !== 'waiting') {
      holding.add(holderBase(lease.holder))
    }
  }
  const first: SimPoolLease[] = []
  const behind: SimPoolLease[] = []
  for (const lease of d.registry.leases) {
    if (lease.state === 'waiting' && wantedClass(lease) === deviceClass) {
      ;(holding.has(holderBase(lease.holder)) ? behind : first).push(lease)
    }
  }
  return first.sort(byArrival).concat(behind.sort(byArrival))
}

export function waitingClasses(d: SimPoolDraft): SimDeviceClass[] {
  const classes: SimDeviceClass[] = []
  for (const lease of d.registry.leases) {
    if (lease.state === 'waiting' && !classes.includes(wantedClass(lease))) {
      classes.push(wantedClass(lease))
    }
  }
  return classes
}

/** Who holds devices of a class now: what a waiter is told it waits on. */
export function holdersOf(d: SimPoolDraft, deviceClass: SimDeviceClass): SimHolder[] {
  return d.registry.leases
    .filter(
      (lease) =>
        lease.state !== 'waiting' &&
        lease.udid !== undefined &&
        d.registry.devices.some(
          (device) => device.udid === lease.udid && deviceClassOf(device.deviceType) === deviceClass
        )
    )
    .map((lease) => lease.holder)
}

/** Number every waiter and say what it waits for; written only where it changed. */
export function updateQueue(d: SimPoolDraft): void {
  for (const deviceClass of waitingClasses(d)) {
    queueOf(d, deviceClass).forEach((lease, index) => {
      const queue = lease.queue ?? { position: 1, since: lease.since, waitingFor: 'device' }
      const unserved = d.unserved.get(lease.leaseId)
      const waitingFor: SimWaitReason = queue.buildId
        ? 'build'
        : unserved === 'creating' || unserved === 'unmakeable'
          ? 'device'
          : (unserved ?? queue.waitingFor)
      if (queue.position !== index + 1 || queue.waitingFor !== waitingFor || !lease.queue) {
        lease.queue = { ...queue, position: index + 1, waitingFor }
      }
    })
  }
}
