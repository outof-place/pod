// Fork-only (Pod): devices whose holder is gone. A leased device whose lease ended is released
// (its app terminated) for the next waiter, or shut down in the same step when the brake ended
// the lease and no waiter takes it. A booted device nobody holds stays up for the warm window,
// then shuts down; under the brake at once; a golden device is never left booted.
import { leaseOn } from '../leases/sim-lease-records'
import { canTakeDevice, deviceFits, queueOf, waitingClasses } from '../leases/sim-lease-queue'
import { isFree } from './sim-pool-allocate'
import { brakeIsTight } from './sim-pool-capacity'
import { startOp } from './sim-pool-devices'
import { deviceState, moveDevice, type SimPoolDevice, type SimPoolDraft } from './sim-pool-draft'
import { trustedListing } from './sim-pool-reconcile'
import { dropWindow, windowDue } from './sim-pool-windows'

function someoneWants(d: SimPoolDraft, device: SimPoolDevice): boolean {
  return waitingClasses(d).some((deviceClass) =>
    queueOf(d, deviceClass).some((lease) => canTakeDevice(lease) && deviceFits(device, lease))
  )
}

/** Keep each device's state in step with the lease that holds it (or with none). */
export function settleHeldDevices(d: SimPoolDraft): void {
  const effects = trustedListing(d) !== null
  for (const device of d.registry.devices) {
    if (device.op) {
      continue
    }
    const lease = leaseOn(d, device.udid)
    const holding = lease?.state === 'active' || lease?.state === 'takeover'
    const state = deviceState(device)
    if (state === 'ready' && holding) {
      moveDevice(d, device, 'lease')
    } else if (state === 'leased' && !holding && effects) {
      const shut = !someoneWants(d, device) && (d.brakeEnded.has(device.udid) || brakeIsTight(d))
      if (shut) {
        moveDevice(d, device, 'release')
        startOp(d, device, 'shutDown')
      } else {
        startOp(d, device, 'release')
      }
    }
  }
}

export function shutDownUnheld(d: SimPoolDraft): void {
  const effects = trustedListing(d) !== null
  const tight = brakeIsTight(d)
  for (const device of d.registry.devices) {
    const warm = `warm:${device.udid}`
    if (deviceState(device) !== 'ready' || !isFree(d, device)) {
      // Held, busy or down: its next free period gets a whole warm window of its own.
      dropWindow(d, warm)
      if (effects && device.role === 'golden' && deviceState(device) === 'ready' && !device.op) {
        startOp(d, device, 'shutDown')
      }
      continue
    }
    const cooled = windowDue(d, warm, 'ready', d.config.warmMs)
    if (effects && (tight || cooled)) {
      startOp(d, device, 'shutDown')
    }
  }
}
