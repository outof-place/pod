// Fork-only (Pod): the pool core's ports, frozen for stage 4b's adapters (simctl in Pod's own
// device set, the pod-sim helper, claude-acc's guard and lease files, the flocked registry file).
// The core never calls them: the coordinator reads them into one observation per poll, steps the
// pure core, and hands its effects to the driver, the lease-file writer and the waiters.
import type { SimHolder, SimHolderLiveness } from '../../../../shared/pod-sim/sim-holder'
import type { SimBrake } from '../../../../shared/pod-sim/sim-pool-snapshot'
import type { SimRegistryFile } from '../../../../shared/pod-sim/sim-registry'
import type { SimHolderFacts } from '../leases/sim-holder-liveness'
import type { SimDeviceOp } from './sim-pool-config'

/** A process (a runtime, or an agent holding a device): pid plus its start, epoch seconds. */
export type SimProcessId = Readonly<{ pid: number; startedAt: number }>

/**
 * Milliseconds. `mono` never steps, and on macOS it runs on while the Mac sleeps (Node's
 * performance.now and process.hrtime read mach_continuous_time, libuv src/unix/darwin.c), so a
 * sleep shows only as a long gap between steps: the core counts a gap longer than
 * SIM_UNOBSERVED_GAP_MS while it was polling as time no rule watched. `wall` is the epoch, what
 * the registry stores; it moving apart from `mono` is a clock step.
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
 * booted outside Pod's set (Filip's, portivo-mobile's). `agentsInUse` is claude-acc's own count of
 * pool devices in use (its `agents_in_use`), for status only: the cap never reads it, since it may
 * include Pod's devices. The adapter maps claude-acc's `normal` to `calm`; a missing value is
 * `unknown`. Without claude-acc the adapter reports Pod's cap and calm.
 */
export type SimCapacityReading = Readonly<{
  source: 'claudeAcc' | 'pod'
  cap: number | 'unknown'
  outsideBooted: number | 'unknown'
  agentsInUse: number | 'unknown'
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
  by: SimProcessId
}>

export type SimOpOutcome = Readonly<{ ok: true; udid?: string } | { ok: false; message: string }>

/**
 * Which slim profile `prepare` and `reset` apply: the app a lease runs, in its worktree (stage 5b
 * derives each app's profile from its build), or null for the pool's default profile.
 */
export type SimSlimProfile = Readonly<{
  app: Readonly<{ id: string; bundleId: string }>
  worktreeRoot: string
}> | null

/** simctl and the helper behind one interface; each method answers, none throws. */
export type SimDeviceDriver = {
  // Answers well within SIM_UNOBSERVED_GAP_MS (`unknown` on a timeout): a poll that takes longer
  // reads to the core as a sleep.
  observe(): Promise<SimDeviceObservation>
  clone(source: string, name: string): Promise<SimOpOutcome>
  create(name: string, deviceType: string, runtime: string): Promise<SimOpOutcome>
  // Boot, apply and verify the slim profile and the project's defaults, shut down.
  prepare(udid: string, profile: SimSlimProfile): Promise<SimOpOutcome>
  boot(udid: string): Promise<SimOpOutcome>
  shutDown(udid: string): Promise<SimOpOutcome>
  // Terminate the holder's app; the device stays booted.
  release(udid: string): Promise<SimOpOutcome>
  // Keep the UDID: shut down, erase, re-apply the slim profile and defaults, boot. The app comes
  // back through SimAppPort.reinstall once the core has seen the reset done.
  reset(udid: string, profile: SimSlimProfile): Promise<SimOpOutcome>
  delete(udid: string): Promise<SimOpOutcome>
}

export type SimCapacityPort = { read(): Promise<SimCapacityReading> }

export type SimLivenessPort = {
  // `resolvedHere`: this runtime resolved the holder (the lease's resolvedBy), so its panes and
  // agent sessions are the ones to look in; any other runtime answers notServedHere for them.
  holderFacts(holder: SimHolder, resolvedHere: boolean): Promise<SimHolderFacts>
  runtime(ref: SimProcessId): Promise<'live' | 'exited'>
  externalUse(): Promise<readonly string[]>
}

export type SimRegistryStoreRead =
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
  read(): Promise<SimRegistryStoreRead>
  swap(token: string, next: SimRegistryFile): Promise<SimRegistrySwap>
}

/**
 * What claude-acc's lease file for a device says (`<simulator_leases>/<UDID>.json`): `owner` is
 * the process its guard checks (the adapter writes `startedAt` as `ps -o lstart`), `session` its
 * `owner.session` (the holder's agent session) and `app` its `lease_app` (the lease's app id).
 */
export type SimLeaseFile = Readonly<{
  owner: SimProcessId
  holder: string
  session?: string
  app?: string
}>

export type SimLeaseFilePort = {
  write(udid: string, file: SimLeaseFile): Promise<void>
  remove(udid: string): Promise<void>
}

/** The RPC layer: re-answer this lease's open `lease --wait` or `wait --mine`. */
export type SimWaiterPort = { notify(leaseId: string): void }

/** Stage 5's app module, for the lease's dev client. */
export type SimAppPort = {
  // `reset app`: uninstall and reinstall it.
  reset(udid: string, leaseId: string): Promise<void>
  // `reset device` erased it: install it again.
  reinstall(udid: string, leaseId: string): Promise<void>
}
