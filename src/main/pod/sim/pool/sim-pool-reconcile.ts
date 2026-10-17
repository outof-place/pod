// Fork-only (Pod): the registry checked against simctl's list of Pod's device set. A device shut
// down outside Pod goes lost then recovers, keeping its lease; one deleted outside goes lost then
// is forgotten, ending its lease `deviceLost`; a booted device is adopted only when the registry
// lists it (the pool's marker). A list simctl could not give, or an empty one while the registry
// has booted devices, changes nothing: losing contact with CoreSimulator is not losing devices.
// A device the list misses while its folder is still in Pod's set is not gone: one partial list
// (CoreSimulator busy) must not end a held device and later delete it.
//
// Pod's set holds nothing but the pool, so a shut-down device of Pod's name the registry does not
// list (a runtime crashed mid-create, the registry was moved aside) is deleted through a registry
// op like any other, unless a create or clone still in flight is making a device of that name.
// One that is booted holds a slot nobody can use, and claude-acc leaves it alone (it reads Pod's
// devices as Filip's own until 4c): once a later list still shows it booted, unused from outside
// and made by no op, Pod shuts it down. It is never adopted (S5): Pod cannot know it was slimmed
// (a crash mid-prepare leaves one half slim), and a shut-down one is deleted on the next list.
import { simDeviceCountsTowardCap } from '../../../../shared/pod-sim/sim-lifecycle'
import { SIM_POD_DEVICE_NAME_PATTERN } from '../../../../shared/pod-sim/sim-pool-snapshot'
import { SIM_DEVICE_MAX_FAILURES } from './sim-pool-config'
import { removeDevice, startOp } from './sim-pool-devices'
import {
  deviceState,
  moveDevice,
  SIM_NO_STRAYS,
  type SimPoolDevice,
  type SimPoolDraft
} from './sim-pool-draft'
import type { SimObservedDevice } from './sim-pool-ports'
import { windowSince } from './sim-pool-windows'

/**
 * The list this step may trust, or null. A device made after the list was taken is not in it. An
 * empty list is lost contact while the registry has booted devices, unless the set's directory
 * was found empty too (the adapter's `onDisk`): then they are gone.
 */
export function trustedListing(d: SimPoolDraft): readonly SimObservedDevice[] | null {
  const observation = d.memory.observation
  const listing = observation?.devices
  if (!observation || !listing || listing.verdict !== 'ok') {
    return null
  }
  if (
    listing.devices.length === 0 &&
    listing.onDisk?.length !== 0 &&
    d.registry.devices.some(
      (device) =>
        simDeviceCountsTowardCap(deviceState(device)) && device.createdAt <= observation.at.wall
    )
  ) {
    return null
  }
  return listing.devices
}

// A forgotten device's delete is its first op: it was never slimmed as far as Pod knows.
const NEVER_SLIM_OPS = new Set(['clone', 'create', 'prepare', 'delete'])

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

const MAKING = new Set(['create', 'clone'])

function listed(d: SimPoolDraft, udid: string): boolean {
  return d.registry.devices.some((device) => device.udid === udid)
}

/** Devices of Pod's name in the list that the registry does not list and no op is making. */
function forgottenIn(d: SimPoolDraft, listing: readonly SimObservedDevice[]): SimObservedDevice[] {
  const ours = `${d.config.namePrefix}Pod-`
  const unknown = listing.filter(
    (seen) =>
      seen.name.startsWith(ours) &&
      SIM_POD_DEVICE_NAME_PATTERN.test(seen.name) &&
      !listed(d, seen.udid)
  )
  if (unknown.length === 0) {
    return unknown
  }
  const making = new Set(
    d.registry.devices.flatMap((device) =>
      device.op && MAKING.has(device.op.kind) ? [device.name] : []
    )
  )
  return unknown.filter((seen) => !making.has(seen.name))
}

/** Booted devices in Pod's set the registry does not list: they hold slots and serve nobody. */
export function unlistedBooted(d: SimPoolDraft): SimObservedDevice[] {
  const seen = d.memory.observation?.devices
  if (seen?.verdict !== 'ok') {
    return []
  }
  return seen.devices.filter((device) => device.state !== 'shutdown' && !listed(d, device.udid))
}

/**
 * A booted forgotten device is shut down once a list newer than this runtime's first sight of it
 * (or than its last shutdown) still shows it booted. Its op is not in the registry (the device is
 * not); both runtimes may ask, and a second shutdown is a no-op.
 */
function shutDownStrays(
  d: SimPoolDraft,
  forgotten: readonly SimObservedDevice[],
  at: number
): void {
  const booted = forgotten.filter((seen) => seen.state === 'booted')
  if (booted.length === 0) {
    d.memory.strays = SIM_NO_STRAYS
    return
  }
  const used = new Set(d.memory.observation?.externalUse ?? [])
  const strays: Record<string, number> = {}
  for (const seen of booted) {
    if (used.has(seen.udid)) {
      continue
    }
    const last = d.memory.strays[seen.udid]
    if (last === undefined || at <= last) {
      strays[seen.udid] = last ?? d.now.mono
      continue
    }
    strays[seen.udid] = d.now.mono
    d.effects.push({
      kind: 'shutDown',
      udid: seen.udid,
      op: { kind: 'shutDown', by: { ...d.self }, since: d.now.wall }
    })
  }
  d.memory.strays = strays
}

function deleteForgotten(d: SimPoolDraft, forgotten: readonly SimObservedDevice[]): void {
  for (const seen of forgotten) {
    if (seen.state !== 'shutdown') {
      continue
    }
    const device: SimPoolDevice = {
      udid: seen.udid,
      name: seen.name,
      role: 'pool',
      deviceType: seen.deviceType ?? 'unknown',
      runtime: seen.runtime ?? 'unknown',
      createdAt: d.now.wall,
      state: 'shutdown'
    }
    d.registry.devices.push(device)
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
  const observation = d.memory.observation?.devices
  const onDisk = observation?.verdict === 'ok' ? (observation.onDisk ?? []) : []
  for (const device of d.registry.devices) {
    const since = windowSince(d, `seen:${device.udid}`, deviceState(device))
    if (device.op || (!fileOlder && at.mono <= since)) {
      continue
    }
    const observed = seen.get(device.udid)
    if (!observed) {
      // Missing from the list but still on disk: a partial list, not a deleted device.
      if (!onDisk.includes(device.udid)) {
        gone(d, device)
      }
    } else if (observed.state === 'booted') {
      bootedOutside(d, device)
    } else if (observed.state === 'shutdown') {
      shutDownOutside(d, device)
    }
  }
  const forgotten = forgottenIn(d, listing)
  deleteForgotten(d, forgotten)
  shutDownStrays(d, forgotten, at.mono)
}
