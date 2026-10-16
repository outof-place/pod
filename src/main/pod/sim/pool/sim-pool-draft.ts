// Fork-only (Pod): one step's working copy of the pool. A step clones the registry and this
// runtime's memory into a draft, every rule edits the draft, and the step returns it with the
// effects for the adapters; nothing outside sees a half-made change.
import {
  simDeviceTransition,
  simLeaseTransition,
  type SimDeviceEvent,
  type SimDeviceState,
  type SimLeaseEvent
} from '../../../../shared/pod-sim/sim-lifecycle'
import {
  SimRegistryDevice,
  SimRegistryLease,
  type SimRegistryFile
} from '../../../../shared/pod-sim/sim-registry'
import type { SimPoolConfig } from './sim-pool-config'
import type {
  SimClockReading,
  SimIdSource,
  SimOpRef,
  SimPoolObservation,
  SimRuntimeRef
} from './sim-pool-ports'
import {
  draftAnchors,
  noAnchors,
  type SimAnchorDraft,
  type SimWindowAnchors
} from './sim-pool-anchors'

export type SimPoolRegistry = SimRegistryFile
export type SimPoolDevice = SimPoolRegistry['devices'][number]
export type SimPoolLease = SimPoolRegistry['leases'][number]
export type SimPoolTombstone = NonNullable<SimPoolRegistry['tombstones']>[number]

/** This runtime's own state, never written to the registry: it dies with the process. */
export type SimPoolMemory = {
  lastTick: SimClockReading | null
  // Monotonic anchors of every window this runtime judges (sim-pool-windows.ts).
  windows: SimWindowAnchors
  observation: SimPoolObservation | null
  // Boots wait after the brake until calm has held (SIM_BRAKE_REBOOT_CALM_MS).
  brakeHold: { calmSince: number | null } | null
  brakeEndsSeen: string[]
  // What this runtime last wrote to each device's claude-acc lease file.
  leaseFiles: Record<string, string>
}

export const EMPTY_SIM_POOL_MEMORY: SimPoolMemory = {
  lastTick: null,
  windows: noAnchors(),
  observation: null,
  brakeHold: null,
  brakeEndsSeen: [],
  leaseFiles: {}
}

type OpEffect<Kind extends SimOpRef['kind'], Extra = object> = Readonly<
  { kind: Kind; udid: string; op: SimOpRef } & Extra
>

export type SimPoolEffect =
  | Readonly<{ kind: 'writeLeaseFile'; udid: string; owner: SimRuntimeRef; holder: string }>
  | Readonly<{ kind: 'removeLeaseFile'; udid: string }>
  | OpEffect<'clone', { source: string; name: string }>
  | OpEffect<'create', { name: string; deviceType: string; runtime: string }>
  | OpEffect<'prepare'>
  | OpEffect<'boot'>
  | OpEffect<'shutDown'>
  | OpEffect<'release'>
  | OpEffect<'reset', { leaseId: string }>
  | OpEffect<'delete'>
  | Readonly<{ kind: 'resetApp'; udid: string; leaseId: string }>
  | Readonly<{ kind: 'notifyWaiter'; leaseId: string }>

export type SimPoolTrace = Readonly<{
  machine: 'device' | 'lease'
  id: string
  from: string
  event: string
  to: string
}>

export type SimPoolInputs = Readonly<{
  now: SimClockReading
  self: SimRuntimeRef
  config: SimPoolConfig
  // Waiting calls (`lease --wait`, `wait --mine`) this runtime holds open, by lease id.
  openCalls: ReadonlySet<string>
  ids: SimIdSource
}>

export type SimPoolDraft = {
  registry: SimPoolRegistry
  memory: Omit<SimPoolMemory, 'windows'> & { windows: SimAnchorDraft }
  effects: SimPoolEffect[]
  trace: SimPoolTrace[]
  now: SimClockReading
  self: SimRuntimeRef
  config: SimPoolConfig
  openCalls: Set<string>
  ids: SimIdSource
  // Per class, why a waiter left without a device in this step (sim-pool-allocate.ts).
  unserved: Map<string, 'slot' | 'brake' | 'device' | 'creating'>
  // Devices whose lease this step ended for the brake: shut down unless a waiter takes them.
  brakeEnded: Set<string>
  // The lease of the call being answered now: it hears its answer, not a notification.
  calling: string | null
  // The earliest monotonic time a window falls due: the coordinator steps again then.
  wakeAt: number | null
}

/**
 * Copy on write, one level deep: each device and lease is a fresh object, tombstones, nested
 * values (a lease's queue, a device's op) and window anchors are shared with the input and only
 * ever replaced, never edited in place (tests step on a frozen registry to keep it so).
 */
export function simPoolDraft(
  state: Readonly<{ registry: SimPoolRegistry; memory: SimPoolMemory }>,
  inputs: SimPoolInputs
): SimPoolDraft {
  const memory = state.memory
  return {
    registry: {
      ...state.registry,
      devices: state.registry.devices.map((device) => ({ ...device })),
      leases: state.registry.leases.map((lease) => ({ ...lease }))
    },
    memory: {
      ...memory,
      windows: draftAnchors(memory.windows),
      leaseFiles: { ...memory.leaseFiles },
      brakeHold: memory.brakeHold ? { ...memory.brakeHold } : null
    },
    effects: [],
    trace: [],
    now: inputs.now,
    self: inputs.self,
    config: inputs.config,
    openCalls: new Set(inputs.openCalls),
    ids: inputs.ids,
    unserved: new Map(),
    brakeEnded: new Set(),
    calling: null,
    wakeAt: null
  }
}

// The core writes only fields the contract names; a peer's unknown fields ride along untouched.
const DEVICE_FIELDS = Object.keys(SimRegistryDevice.shape)
const LEASE_FIELDS = Object.keys(SimRegistryLease.shape)

/** Whether a step changed what the registry file would say (`updatedAt` aside). */
export function registryChanged(before: SimPoolRegistry, after: SimPoolRegistry): boolean {
  return (
    after.tombstones !== before.tombstones ||
    !sameRows(after.devices, before.devices, DEVICE_FIELDS) ||
    !sameRows(after.leases, before.leases, LEASE_FIELDS)
  )
}

function sameRows(
  after: readonly Readonly<Record<string, unknown>>[],
  before: readonly Readonly<Record<string, unknown>>[],
  fields: readonly string[]
): boolean {
  if (after.length !== before.length) {
    return false
  }
  for (let row = 0; row < after.length; row += 1) {
    for (const field of fields) {
      if (!sameJson(after[row][field], before[row][field])) {
        return false
      }
    }
  }
  return true
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether two decoded JSON values would serialize alike (an undefined field is no field). */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true
  }
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((item, i) => sameJson(item, b[i]))
  }
  if (!isRecord(a) || !isRecord(b)) {
    return false
  }
  let fields = 0
  for (const key in a) {
    if (a[key] !== undefined) {
      fields += 1
      if (!sameJson(a[key], b[key])) {
        return false
      }
    }
  }
  for (const key in b) {
    if (b[key] !== undefined) {
      fields -= 1
    }
  }
  return fields === 0
}

/** Every device move goes through the frozen table; a move it refuses is a bug in the core. */
export function moveDevice(d: SimPoolDraft, device: SimPoolDevice, event: SimDeviceEvent): void {
  const from: SimDeviceState = device.state ?? 'shutdown'
  const outcome = simDeviceTransition(from, event)
  if (!outcome.ok) {
    throw new Error(`pool core: device ${device.name} cannot ${event} from ${from}`)
  }
  device.state = outcome.to
  d.trace.push({ machine: 'device', id: device.udid, from, event, to: outcome.to })
}

export function moveLease(d: SimPoolDraft, lease: SimPoolLease, event: SimLeaseEvent): void {
  const from = lease.state
  const outcome = simLeaseTransition(from, event)
  if (!outcome.ok) {
    throw new Error(`pool core: lease ${lease.leaseId} cannot ${event} from ${from}`)
  }
  lease.state = outcome.to
  d.trace.push({ machine: 'lease', id: lease.leaseId, from, event, to: outcome.to })
}

export function deviceState(device: SimPoolDevice): SimDeviceState {
  return device.state ?? 'shutdown'
}

export function runtimeKey(ref: SimRuntimeRef): string {
  return `${ref.pid}:${ref.startedAt}`
}

export function sameRuntime(a: SimRuntimeRef, b: SimRuntimeRef): boolean {
  return a.pid === b.pid && a.startedAt === b.startedAt
}
