// Fork-only (Pod): the registry checked against simctl's list of Pod's device set. A device shut
// down outside Pod goes lost then recovers, keeping its lease; one deleted outside goes lost then
// is forgotten, ending its lease `deviceLost`; a booted device is adopted only when the registry
// lists it (the pool's marker). A list simctl could not give, or an empty one while the registry
// has booted devices, changes nothing: losing contact with CoreSimulator is not losing devices.
import { simDeviceCountsTowardCap } from '../../../../shared/pod-sim/sim-lifecycle'
import { SIM_DEVICE_MAX_FAILURES } from './sim-pool-config'
import { removeDevice, startOp } from './sim-pool-devices'
import { deviceState, moveDevice, type SimPoolDevice, type SimPoolDraft } from './sim-pool-draft'
import type { SimObservedDevice } from './sim-pool-ports'
import { windowSince } from './sim-pool-windows'

/** The list this step may trust, or null. A device made after the list was taken is not in it. */
export function trustedListing(d: SimPoolDraft): readonly SimObservedDevice[] | null {
  const observation = d.memory.observation
  const listing = observation?.devices
  if (!observation || !listing || listing.verdict !== 'ok') {
    return null
  }
  if (
    listing.devices.length === 0 &&
    d.registry.devices.some(
      (device) =>
        simDeviceCountsTowardCap(deviceState(device)) && device.createdAt <= observation.at.wall
    )
  ) {
    return null
  }
  return listing.devices
}

const NEVER_SLIM_OPS = new Set(['clone', 'create', 'prepare'])

/** A device that failed before it was ever slimmed, or too often, is not worth another boot. */
export function hopeless(device: SimPoolDevice): boolean {
  const failure = device.failure
  return (
    failure !== undefined &&
    ((failure.op !== undefined && NEVER_SLIM_OPS.has(failure.op)) ||
      failure.count >= SIM_DEVICE_MAX_FAILURES)
  )
}

function gone(d: SimPoolDraft, device: SimPoolDevice): void {
  const state = deviceState(device)
  if (state === 'shutdown') {
    moveDevice(d, device, 'delete')
  } else {
    if (state === 'cloning') {
      moveDevice(d, device, 'fail')
    }
    if (state !== 'lost') {
      moveDevice(d, device, 'lost')
    }
    moveDevice(d, device, 'forget')
  }
  removeDevice(d, device)
}

function bootedOutside(d: SimPoolDraft, device: SimPoolDevice): void {
  const state = deviceState(device)
  if (state === 'shutdown') {
    moveDevice(d, device, 'boot')
    moveDevice(d, device, 'booted')
  } else if (state === 'failed') {
    startOp(d, device, 'shutDown')
  }
}

function shutDownOutside(d: SimPoolDraft, device: SimPoolDevice): void {
  const state = deviceState(device)
  if (state === 'shuttingDown') {
    moveDevice(d, device, 'shutDownDone')
  } else if (state === 'failed' || state === 'lost') {
    moveDevice(d, device, 'recover')
  } else if (
    state !== 'shutdown' &&
    state !== 'preparing' &&
    state !== 'absent' &&
    state !== 'cloning'
  ) {
    moveDevice(d, device, 'lost')
    moveDevice(d, device, 'recover')
  }
  if (deviceState(device) === 'shutdown' && hopeless(device)) {
    startOp(d, device, 'delete')
  }
}

/**
 * Runs on polls only: a command's step carries the last poll's list, older than what the command
 * may have just changed. A record is judged by a list only when the list is newer than the record:
 * the file was last written before the list was taken, or this runtime saw the record as it is
 * before the list was taken.
 */
export function reconcileDevices(d: SimPoolDraft, writtenAt: number): void {
  const listing = trustedListing(d)
  const at = d.memory.observation?.at
  if (!listing || !at) {
    return
  }
  const fileOlder = writtenAt < at.wall
  const seen = new Map(listing.map((device) => [device.udid, device]))
  for (const device of d.registry.devices) {
    const since = windowSince(d, `seen:${device.udid}`, deviceState(device))
    if (device.op || (!fileOlder && at.mono <= since)) {
      continue
    }
    const observed = seen.get(device.udid)
    if (!observed) {
      gone(d, device)
    } else if (observed.state === 'booted') {
      bootedOutside(d, device)
    } else if (observed.state === 'shutdown') {
      shutDownOutside(d, device)
    }
  }
}
