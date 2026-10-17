// Fork-only (Pod): whether the pool may boot one more device. Pod's own devices that hold a slot
// (every state that counts, plus boot, prepare and reset ops in flight), devices in Pod's set it
// never adopted, and devices booted outside Pod (claude-acc's reading) must stay within the cap. A
// reading older than 30 s, or one that does not know a number, opens no slot: claude-acc going
// quiet is not calm, nor is it the brake: the waiter waits for a `measurement`. Booted free devices
// are still handed out; only boots wait.
//
// A device waiting to be slimmed (`preparing`, no prepare running) holds its slot without being
// booted, and a clone in flight will hold one: the pool makes a device only into a slot nobody
// holds, and a waiting slim boots as soon as what is really booted leaves room for it, so devices
// made before the brake rose (or an outside boot took a slot) are slimmed once it falls.
import { simDeviceCountsTowardCap } from '../../../../shared/pod-sim/sim-lifecycle'
import type { SimBrake } from '../../../../shared/pod-sim/sim-pool-snapshot'
import {
  SIM_BRAKE_REBOOT_CALM_MS,
  SIM_CAPACITY_FRESH_MS,
  SIM_CAPACITY_FUTURE_MS
} from './sim-pool-config'
import { deviceState, type SimPoolDevice, type SimPoolDraft } from './sim-pool-draft'
import type { SimCapacityReading } from './sim-pool-ports'
import { wakeAt } from './sim-pool-windows'

export type SimBootGate = 'open' | 'slot' | 'brake' | 'measurement'

const IN_FLIGHT = new Set(['boot', 'prepare', 'reset'])

/** Whether a reading is recent enough to boot on: claude-acc keeps its stage 30 s. */
export function capacityIsFresh(reading: SimCapacityReading | undefined, wall: number): boolean {
  if (!reading || reading.measuredAt === null) {
    return false
  }
  const age = wall - reading.measuredAt
  return age <= SIM_CAPACITY_FRESH_MS && age >= -SIM_CAPACITY_FUTURE_MS
}

function freshReading(d: SimPoolDraft): SimCapacityReading | null {
  const reading = d.memory.observation?.capacity
  return reading && capacityIsFresh(reading, d.now.wall) ? reading : null
}

/** claude-acc's brake stage, or null when the reading is stale or does not know it. */
export function freshBrake(d: SimPoolDraft): SimBrake | null {
  const brake = freshReading(d)?.brake
  return brake === undefined || brake === 'unknown' ? null : brake
}

export function brakeIsTight(d: SimPoolDraft): boolean {
  const brake = freshBrake(d)
  return brake !== null && brake !== 'calm'
}

export function usedSlots(d: SimPoolDraft): number {
  let used = 0
  for (const device of d.registry.devices) {
    if (
      simDeviceCountsTowardCap(deviceState(device)) ||
      (device.op && IN_FLIGHT.has(device.op.kind))
    ) {
      used += 1
    }
  }
  const seen = d.memory.observation?.devices
  if (seen?.verdict === 'ok') {
    for (const device of seen.devices) {
      if (device.state !== 'shutdown' && !listed(d, device.udid)) {
        used += 1
      }
    }
  }
  return used
}

function listed(d: SimPoolDraft, udid: string): boolean {
  for (const device of d.registry.devices) {
    if (device.udid === udid) {
      return true
    }
  }
  return false
}

function countDevices(d: SimPoolDraft, which: (device: SimPoolDevice) => boolean): number {
  let count = 0
  for (const device of d.registry.devices) {
    count += which(device) ? 1 : 0
  }
  return count
}

function awaitingSlim(device: SimPoolDevice): boolean {
  return deviceState(device) === 'preparing' && device.op?.kind !== 'prepare'
}

/** May one more device boot? */
export function bootGate(d: SimPoolDraft): SimBootGate {
  return gate(d, 1)
}

/** May the pool make one more device? Clones in flight hold the slots they will need. */
export function provisionGate(d: SimPoolDraft): SimBootGate {
  return gate(d, 1 + countDevices(d, (device) => deviceState(device) === 'cloning'))
}

/** May a device waiting to be slimmed boot for it? Only booted devices must leave it room. */
export function slimGate(d: SimPoolDraft): SimBootGate {
  return gate(d, 1 - countDevices(d, awaitingSlim))
}

/** Whether `slots` more than usedSlots fit under the cap (fewer when some counted are not booted). */
function gate(d: SimPoolDraft, slots: number): SimBootGate {
  const reading = freshReading(d)
  if (
    !reading ||
    reading.cap === 'unknown' ||
    reading.outsideBooted === 'unknown' ||
    reading.brake === 'unknown'
  ) {
    return 'measurement'
  }
  if (reading.brake === 'brake' || reading.brake === 'emergency' || d.memory.brakeHold) {
    return 'brake'
  }
  // claude-acc's 0 is "no cap there"; Pod's own cap is never unlimited.
  const cap = reading.cap > 0 ? reading.cap : d.config.podCap
  return usedSlots(d) + reading.outsideBooted + slots <= cap ? 'open' : 'slot'
}

export function armBrakeHold(d: SimPoolDraft): void {
  d.memory.brakeHold = { calmSince: null }
}

/**
 * After `brake` or `emergency`, or a device shut down for the brake by any runtime (its
 * `memoryBrake` tombstone), boots wait until calm has held SIM_BRAKE_REBOOT_CALM_MS.
 */
export function updateBrakeHold(d: SimPoolDraft): void {
  const brake = freshBrake(d)
  if (brake === 'brake' || brake === 'emergency') {
    armBrakeHold(d)
  }
  const brakeEnds = (d.registry.tombstones ?? []).filter(
    (ended) => ended.ended.reason === 'memoryBrake'
  )
  const seen = new Set(d.memory.brakeEndsSeen)
  for (const ended of brakeEnds) {
    if (!seen.has(ended.leaseId) && d.now.wall - ended.ended.at <= SIM_BRAKE_REBOOT_CALM_MS) {
      armBrakeHold(d)
    }
  }
  d.memory.brakeEndsSeen = brakeEnds.map((ended) => ended.leaseId)
  const hold = d.memory.brakeHold
  if (!hold) {
    return
  }
  if (brake !== 'calm') {
    hold.calmSince = null
    return
  }
  hold.calmSince ??= d.now.mono
  if (d.now.mono - hold.calmSince >= SIM_BRAKE_REBOOT_CALM_MS) {
    d.memory.brakeHold = null
  } else {
    wakeAt(d, hold.calmSince + SIM_BRAKE_REBOOT_CALM_MS)
  }
}
