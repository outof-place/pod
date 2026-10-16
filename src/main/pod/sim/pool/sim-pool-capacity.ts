// Fork-only (Pod): whether the pool may boot one more device. Pod's own devices that hold a slot
// (every state that counts, plus boot, prepare and reset ops in flight), devices in Pod's set it
// never adopted, and devices booted outside Pod (claude-acc's reading) must stay within the cap. A
// reading older than 30 s, or one that does not know a number, opens no slot: claude-acc going
// quiet is not calm. Booted free devices are still handed out; only boots wait.
import { simDeviceCountsTowardCap } from '../../../../shared/pod-sim/sim-lifecycle'
import type { SimBrake } from '../../../../shared/pod-sim/sim-pool-snapshot'
import {
  SIM_BRAKE_REBOOT_CALM_MS,
  SIM_CAPACITY_FRESH_MS,
  SIM_CAPACITY_FUTURE_MS
} from './sim-pool-config'
import { deviceState, type SimPoolDraft } from './sim-pool-draft'
import type { SimCapacityReading } from './sim-pool-ports'
import { wakeAt } from './sim-pool-windows'

export type SimBootGate = 'open' | 'slot' | 'brake'

const IN_FLIGHT = new Set(['boot', 'prepare', 'reset'])

function freshReading(d: SimPoolDraft): SimCapacityReading | null {
  const reading = d.memory.observation?.capacity
  if (!reading || reading.measuredAt === null) {
    return null
  }
  const age = d.now.wall - reading.measuredAt
  return age <= SIM_CAPACITY_FRESH_MS && age >= -SIM_CAPACITY_FUTURE_MS ? reading : null
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

/** May `slots` more devices boot? A device already counted (preparing) asks for 0. */
export function bootGate(d: SimPoolDraft, slots = 1): SimBootGate {
  const reading = freshReading(d)
  if (
    !reading ||
    reading.cap === 'unknown' ||
    reading.outsideBooted === 'unknown' ||
    reading.brake === 'unknown' ||
    reading.brake === 'brake' ||
    reading.brake === 'emergency' ||
    d.memory.brakeHold
  ) {
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
