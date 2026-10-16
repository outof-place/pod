// Fork-only (Pod): the pool core's ports, frozen for stage 4b's adapters (simctl in Pod's own
// device set, the pod-sim helper, claude-acc's guard and lease files, the flocked registry file).
// The core never calls them: the coordinator reads them into one observation per poll, steps the
// pure core, and hands its effects to the driver, the lease-file writer and the waiters.
import type { SimHolder, SimHolderLiveness } from '../../../../shared/pod-sim/sim-holder'
import type { SimBrake } from '../../../../shared/pod-sim/sim-pool-snapshot'
import type { SimRegistryFile } from '../../../../shared/pod-sim/sim-registry'
import type { SimHolderFacts } from '../leases/sim-holder-liveness'
import type { SimDeviceOp } from './sim-pool-config'

export type SimRuntimeRef = Readonly<{ pid: number; startedAt: number }>

/**
 * Milliseconds. `mono` never steps and stops while the Mac sleeps (mach_absolute_time or
 * CLOCK_UPTIME_RAW, as Node's performance.now is on macOS), so a sleep shows as wall time moving
 * without it; `wall` is the epoch, what the registry stores.
 */
export type SimClockReading = Readonly<{ mono: number; wall: number }>
export type SimClock = { now(): SimClockReading }

export type SimIdSource = Readonly<{
  /** `sl_` plus 4 to 32 of [0-9a-z]. */
  leaseId(): string
  /** An uppercase UUID: a device's provisional UDID until simctl names the real one. */
  deviceId(): string
}>

/** One device simctl lists in Pod's device set. */
export type SimObservedDevice = Readonly<{
  udid: string
  name: string
  state: 'booted' | 'shutdown' | 'transitioning'
}>

/**
 * Pod's device set as simctl lists it. `unknown`: simctl timed out or failed; the core then
 * changes no device (no lost, recover, boot or shut down) until a list it can trust.
 */
export type SimDeviceObservation =
  | Readonly<{ verdict: 'ok'; devices: readonly SimObservedDevice[] }>
  | Readonly<{ verdict: 'unknown'; why: string }>

/**
 * claude-acc's view. `cap` 0 is "no cap there" (Pod's own applies); `outsideBooted` counts devices
 * booted outside Pod's set (Filip's, portivo-mobile's). The adapter maps claude-acc's `normal` to
 * `calm`; a missing value is `unknown`. Without claude-acc the adapter reports Pod's cap and calm.
 */
export type SimCapacityReading = Readonly<{
  source: 'claudeAcc' | 'pod'
  cap: number | 'unknown'
  outsideBooted: number | 'unknown'
  brake: SimBrake | 'unknown'
  measuredAt: number | null
}>

/** Everything one poll saw, read by the coordinator just before it steps the core. */
export type SimPoolObservation = Readonly<{
  at: SimClockReading
  devices: SimDeviceObservation
  capacity: SimCapacityReading
  // Per live lease: whether its holder lives (sim-holder-liveness.ts over the adapter's facts).
  liveness: Readonly<Record<string, SimHolderLiveness>>
  // Per runtime named by a lease's servedBy or an op's by, keyed `pid:startedAt`.
  runtimes: Readonly<Record<string, 'live' | 'exited'>>
  // UDIDs in the argv of a process outside Pod (Maestro, agent-device): use, as claude-acc's
  // watcher rule counts it (devguard_core.py discover_simulators).
  externalUse: readonly string[]
}>

export type SimOpRef = Readonly<{
  kind: SimDeviceOp
  since: number
  by: SimRuntimeRef
}>

export type SimOpOutcome = Readonly<{ ok: true; udid?: string } | { ok: false; message: string }>

/** simctl and the helper behind one interface; each method answers, none throws. */
export type SimDeviceDriver = {
  observe(): Promise<SimDeviceObservation>
  clone(source: string, name: string): Promise<SimOpOutcome>
  create(name: string, deviceType: string, runtime: string): Promise<SimOpOutcome>
  // Boot, apply and verify the slim profile and the project's defaults, shut down.
  prepare(udid: string): Promise<SimOpOutcome>
  boot(udid: string): Promise<SimOpOutcome>
  shutDown(udid: string): Promise<SimOpOutcome>
  // Terminate the holder's app; the device stays booted.
  release(udid: string): Promise<SimOpOutcome>
  // Keep the UDID: shut down, erase, re-apply slim and defaults, boot.
  reset(udid: string): Promise<SimOpOutcome>
  delete(udid: string): Promise<SimOpOutcome>
}

export type SimCapacityPort = { read(): Promise<SimCapacityReading> }

export type SimLivenessPort = {
  holderFacts(holder: SimHolder, servedHere: boolean): Promise<SimHolderFacts>
  runtime(ref: SimRuntimeRef): Promise<'live' | 'exited'>
  externalUse(): Promise<readonly string[]>
}

export type SimRegistryRead =
  | Readonly<{ ok: true; registry: SimRegistryFile; token: string }>
  | Readonly<{ ok: false; reason: 'registryUnreadable'; message: string }>

export type SimRegistrySwap =
  | Readonly<{ ok: true; token: string }>
  | Readonly<{ ok: false; reason: 'conflict' }>
  | Readonly<{ ok: false; reason: 'registryUnreadable'; message: string }>

/**
 * The Mac-wide registry. `swap` writes only when the file is still the one `token` named (under
 * the flock, temp file plus rename), else answers `conflict` and writes nothing.
 */
export type SimRegistryStore = {
  read(): Promise<SimRegistryRead>
  swap(token: string, next: SimRegistryFile): Promise<SimRegistrySwap>
}

/** claude-acc's lease file per device (`<simulator_leases>/<UDID>.json`, owner pid and start). */
export type SimLeaseFilePort = {
  write(udid: string, owner: SimRuntimeRef, holder: string): Promise<void>
  remove(udid: string): Promise<void>
}

/** The RPC layer: re-answer this lease's open `lease --wait` or `wait --mine`. */
export type SimWaiterPort = { notify(leaseId: string): void }

/** Stage 5's app module: uninstall and reinstall the lease's dev client (`reset app`). */
export type SimAppPort = { reset(udid: string, leaseId: string): Promise<void> }
