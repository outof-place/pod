// Fork-only (Pod): the simulator pool's two frozen state machines, devices and leases (stage 1 of
// the native simulators plan). The pool core (stage 4) moves records only through these tables;
// fixtures/transitions.json is the source both TS and PodNative's Swift decode.

/**
 * A pool device. `cloning` and `preparing` (re-slim, `simslim verify`) come before it may boot;
 * `lost` is a device shut down or deleted from outside, until the pool reconciles it. Any booted
 * state can `fail` or be `lost` at any moment; `failed` keeps its boot slot until it leaves
 * (`recover` once simctl reports it Shutdown, else `shutDown`).
 */
export const SIM_DEVICE_STATES = [
  'absent',
  'cloning',
  'preparing',
  'shutdown',
  'booting',
  'ready',
  'leased',
  'resetting',
  'releasing',
  'shuttingDown',
  'failed',
  'lost'
] as const
export type SimDeviceState = (typeof SIM_DEVICE_STATES)[number]

export const SIM_DEVICE_EVENTS = [
  'create',
  'clone',
  'cloned',
  'prepared',
  'boot',
  'booted',
  'lease',
  'reset',
  'resetDone',
  'release',
  'released',
  'shutDown',
  'shutDownDone',
  'fail',
  'lost',
  'recover',
  'forget',
  'delete'
] as const
export type SimDeviceEvent = (typeof SIM_DEVICE_EVENTS)[number]

/**
 * A holder's claim on a device. A lease is born `waiting`; `reserved` holds a ready device for it
 * until it claims (SIM_RESERVATION_CLAIM_S) or lapses, and a lapsed waiter rejoins the queue at
 * the back. A waiter silent for SIM_WAITER_ABANDON_S is abandoned, and one whose dev-client build
 * failed ends too. `expired` (Pod ended it: `ended.reason` says why) and `released` are final.
 * A takeover outlives its agent: the person keeps driving, and once they give the device back
 * (or go idle) the lease is active again and the next liveness check releases it. A removed
 * worktree ends any live lease, and a device deleted outside Pod ends the lease that held it (a
 * takeover too): both `expired`, with `ended.reason` naming why.
 */
export const SIM_LEASE_STATES = [
  'waiting',
  'reserved',
  'active',
  'takeover',
  'expired',
  'released'
] as const
export type SimLeaseState = (typeof SIM_LEASE_STATES)[number]

export const SIM_LEASE_FINAL_STATES = ['expired', 'released'] as const satisfies SimLeaseState[]

export const SIM_LEASE_EVENTS = [
  'reserve',
  'lapse',
  'claim',
  'takeover',
  'giveBack',
  'revoke',
  'abandon',
  'buildFailed',
  'release',
  'holderExited',
  'worktreeRemoved',
  'deviceLost'
] as const
export type SimLeaseEvent = (typeof SIM_LEASE_EVENTS)[number]

export type SimTransition<State, Event> = Readonly<{ from: State; event: Event; to: State }>

export const SIM_DEVICE_TRANSITIONS: readonly SimTransition<SimDeviceState, SimDeviceEvent>[] = [
  { from: 'absent', event: 'create', to: 'preparing' },
  { from: 'absent', event: 'clone', to: 'cloning' },
  { from: 'cloning', event: 'cloned', to: 'preparing' },
  { from: 'cloning', event: 'fail', to: 'failed' },
  { from: 'preparing', event: 'prepared', to: 'shutdown' },
  { from: 'preparing', event: 'fail', to: 'failed' },
  { from: 'preparing', event: 'lost', to: 'lost' },
  { from: 'shutdown', event: 'boot', to: 'booting' },
  { from: 'shutdown', event: 'delete', to: 'absent' },
  { from: 'booting', event: 'booted', to: 'ready' },
  { from: 'booting', event: 'fail', to: 'failed' },
  { from: 'booting', event: 'lost', to: 'lost' },
  { from: 'ready', event: 'lease', to: 'leased' },
  { from: 'ready', event: 'shutDown', to: 'shuttingDown' },
  { from: 'ready', event: 'fail', to: 'failed' },
  { from: 'ready', event: 'lost', to: 'lost' },
  { from: 'leased', event: 'release', to: 'releasing' },
  { from: 'leased', event: 'reset', to: 'resetting' },
  { from: 'leased', event: 'fail', to: 'failed' },
  { from: 'leased', event: 'lost', to: 'lost' },
  { from: 'resetting', event: 'resetDone', to: 'leased' },
  { from: 'resetting', event: 'fail', to: 'failed' },
  { from: 'resetting', event: 'lost', to: 'lost' },
  { from: 'releasing', event: 'released', to: 'ready' },
  { from: 'releasing', event: 'shutDown', to: 'shuttingDown' },
  { from: 'releasing', event: 'fail', to: 'failed' },
  { from: 'releasing', event: 'lost', to: 'lost' },
  { from: 'shuttingDown', event: 'shutDownDone', to: 'shutdown' },
  { from: 'shuttingDown', event: 'fail', to: 'failed' },
  { from: 'shuttingDown', event: 'lost', to: 'lost' },
  { from: 'failed', event: 'shutDown', to: 'shuttingDown' },
  { from: 'failed', event: 'recover', to: 'shutdown' },
  { from: 'failed', event: 'lost', to: 'lost' },
  { from: 'failed', event: 'delete', to: 'absent' },
  { from: 'lost', event: 'recover', to: 'shutdown' },
  { from: 'lost', event: 'forget', to: 'absent' }
]

export const SIM_LEASE_TRANSITIONS: readonly SimTransition<SimLeaseState, SimLeaseEvent>[] = [
  { from: 'waiting', event: 'reserve', to: 'reserved' },
  { from: 'waiting', event: 'abandon', to: 'expired' },
  { from: 'waiting', event: 'buildFailed', to: 'expired' },
  { from: 'waiting', event: 'release', to: 'released' },
  { from: 'waiting', event: 'holderExited', to: 'released' },
  { from: 'waiting', event: 'worktreeRemoved', to: 'expired' },
  { from: 'reserved', event: 'claim', to: 'active' },
  { from: 'reserved', event: 'lapse', to: 'waiting' },
  { from: 'reserved', event: 'buildFailed', to: 'expired' },
  { from: 'reserved', event: 'release', to: 'released' },
  { from: 'reserved', event: 'holderExited', to: 'released' },
  { from: 'reserved', event: 'worktreeRemoved', to: 'expired' },
  { from: 'active', event: 'takeover', to: 'takeover' },
  { from: 'active', event: 'revoke', to: 'expired' },
  { from: 'active', event: 'release', to: 'released' },
  { from: 'active', event: 'holderExited', to: 'released' },
  { from: 'active', event: 'worktreeRemoved', to: 'expired' },
  { from: 'active', event: 'deviceLost', to: 'expired' },
  { from: 'takeover', event: 'giveBack', to: 'active' },
  { from: 'takeover', event: 'release', to: 'released' },
  { from: 'takeover', event: 'holderExited', to: 'takeover' },
  { from: 'takeover', event: 'worktreeRemoved', to: 'expired' },
  { from: 'takeover', event: 'deviceLost', to: 'expired' }
]

/** Why a device refuses an event: the state it is in. */
export const SIM_DEVICE_REFUSALS = {
  absent: 'device_absent',
  cloning: 'device_cloning',
  preparing: 'device_preparing',
  shutdown: 'device_shut_down',
  booting: 'device_booting',
  ready: 'device_ready',
  leased: 'device_leased',
  resetting: 'device_resetting',
  releasing: 'device_releasing',
  shuttingDown: 'device_shutting_down',
  failed: 'device_failed',
  lost: 'device_lost'
} as const satisfies Record<SimDeviceState, string>

/**
 * Why a lease refuses an event. The pool core's own reasons, for its logs and tests: an agent
 * never sees them, it gets a SimRefusal (sim-refusals.ts) built from the lease it holds.
 */
export const SIM_LEASE_REFUSALS = {
  waiting: 'lease_waiting',
  reserved: 'lease_reserved',
  active: 'lease_active',
  takeover: 'lease_taken_over',
  expired: 'lease_expired',
  released: 'lease_released'
} as const satisfies Record<SimLeaseState, string>

export type SimDeviceRefusal = (typeof SIM_DEVICE_REFUSALS)[SimDeviceState]
export type SimLeaseRefusal = (typeof SIM_LEASE_REFUSALS)[SimLeaseState]

export type SimTransitionOutcome<State, Reason> =
  | { ok: true; to: State }
  | { ok: false; reason: Reason }

function transition<State extends string, Event extends string, Reason>(
  table: readonly SimTransition<State, Event>[],
  refusals: Record<State, Reason>,
  from: State,
  event: Event
): SimTransitionOutcome<State, Reason> {
  const row = table.find((candidate) => candidate.from === from && candidate.event === event)
  return row ? { ok: true, to: row.to } : { ok: false, reason: refusals[from] }
}

export function simDeviceTransition(
  from: SimDeviceState,
  event: SimDeviceEvent
): SimTransitionOutcome<SimDeviceState, SimDeviceRefusal> {
  return transition(SIM_DEVICE_TRANSITIONS, SIM_DEVICE_REFUSALS, from, event)
}

export function simLeaseTransition(
  from: SimLeaseState,
  event: SimLeaseEvent
): SimTransitionOutcome<SimLeaseState, SimLeaseRefusal> {
  return transition(SIM_LEASE_TRANSITIONS, SIM_LEASE_REFUSALS, from, event)
}

const FINAL_LEASE_STATES: ReadonlySet<SimLeaseState> = new Set(SIM_LEASE_FINAL_STATES)

export function simLeaseIsFinal(state: SimLeaseState): boolean {
  return FINAL_LEASE_STATES.has(state)
}

const BOOTED_STATES: ReadonlySet<SimDeviceState> = new Set([
  'preparing',
  'booting',
  'ready',
  'leased',
  'resetting',
  'releasing',
  'shuttingDown',
  'failed'
])

/**
 * Whether the device holds a boot slot: its launchd_sim may exist. `preparing` does, since simslim
 * boots a device to slim it.
 */
export function simDeviceCountsTowardCap(state: SimDeviceState): boolean {
  return BOOTED_STATES.has(state)
}

const GIVABLE_STATES: ReadonlySet<SimDeviceState> = new Set(['shutdown', 'ready'])

/**
 * Whether the pool may give this device to a waiter (booting it first when shut down): a pool
 * device that no live lease names. A device that came back while its lease stayed live (lost,
 * recovered, booted again) is still that lease's: one device, one holder.
 */
export function simDeviceIsFree(
  device: Readonly<{ udid: string; role: 'golden' | 'pool'; state: SimDeviceState }>,
  leases: readonly Readonly<{ udid?: string; state: SimLeaseState }>[]
): boolean {
  return (
    device.role === 'pool' &&
    GIVABLE_STATES.has(device.state) &&
    !leases.some((lease) => lease.udid === device.udid && !simLeaseIsFinal(lease.state))
  )
}
