// Fork-only (Pod): the pool core's ports, frozen for stage 4b's adapters (simctl in Pod's own
// device set, the pod-sim helper, claude-acc's guard and lease files, the flocked registry file).
// The core never calls them: the coordinator reads them into one observation per poll, steps the
// pure core, and hands its effects to the driver, the lease-file writer and the waiters.
import type { SimHolder, SimHolderLiveness } from '../../../../shared/pod-sim/sim-holder'
import type { SimBrake } from '../../../../shared/pod-sim/sim-pool-snapshot'
import type { SimRegistryFile } from '../../../../shared/pod-sim/sim-registry'
import type { SimHolderFacts } from '../leases/sim-holder-liveness'
import type { SimDeviceOp } from './sim-pool-config'

/**
 * A process (a runtime, or an agent holding a device): pid plus its start. `startedAt` is the
 * kernel's start of that pid in epoch seconds, read by every side the same way, through
 * SimProcessFacts.startOf (`ps` under TZ=UTC0, read as UTC): the runtime naming itself
 * (simRuntimeOf), stage 7 resolving an agent holder, and every liveness check of either. Never a
 * process's own idea of its start (performance.timeOrigin drifts seconds from the kernel's on a
 * slow start) and never a local-time reading (zones and DST move it by hours). claude-acc's lease
 * file keeps its own local-time `owner.start` (its contract), written from this value.
 */
export type SimProcessId = Readonly<{ pid: number; startedAt: number }>

/**
 * This runtime: its process, and a stable id of the Pod profile it runs (4b: of its userData
 * directory), the same after a restart and different for a probe's profile. A restarted Pod sees
 * the panes and agent sessions its previous process resolved holders in; another profile never.
 */
export type SimRuntime = SimProcessId & Readonly<{ profile: string }>

/**
 * Milliseconds. `mono` never steps, and on macOS it runs on while the Mac sleeps (Node's
 * performance.now and process.hrtime read mach_continuous_time, libuv src/unix/darwin.c). `wall`
 * is the epoch, what the registry stores; it moving apart from `mono` is a clock step.
 *
 * Only the sleep signal says time went unwatched: `suspends` counts Electron powerMonitor
 * `suspend` events since the runtime started, and `suspended` is true from one until the next
 * `resume`. A long gap between steps without it is awake time (App Nap throttles the nested
 * `LSUIElement` runtime's timers to a poll a minute or more, and every window must still fall
 * due). 4b counts `suspend` itself, not only `resume`: it comes before the sleep, so the first
 * step after waking sees it whichever of the overdue timer and `resume` the loop delivers first.
 */
export type SimClockReading = Readonly<{
  mono: number
  wall: number
  suspends: number
  suspended: boolean
}>
export type SimClock = { now(): SimClockReading }

export type SimIdSource = Readonly<{
  /** `sl_` plus 4 to 32 of [0-9a-z]. */
  leaseId(): string
  /** An uppercase UUID: a device's provisional UDID until simctl names the real one. */
  deviceId(): string
}>

/**
 * One device simctl lists in Pod's device set. `deviceType` and `runtime` (simctl's identifiers)
 * let the core enter a device the registry forgot, to delete it (sim-pool-reconcile.ts).
 */
export type SimObservedDevice = Readonly<{
  udid: string
  name: string
  state: 'booted' | 'shutdown' | 'transitioning'
  deviceType?: string
  runtime?: string
}>

/**
 * Pod's device set as simctl lists it. `unknown`: simctl timed out or failed, or the set could not
 * be read; the core then changes no device (no lost, recover, boot or shut down) until a list it
 * can trust. `onDisk`: the UDIDs with a directory in the set when the list was taken (absent when
 * the adapter did not look). A device the list misses but the disk still has is not gone (a
 * partial list), and an empty list is believed only when the disk is empty too (an empty list
 * alone, while the registry has booted devices, is lost contact).
 */
export type SimDeviceObservation =
  | Readonly<{
      verdict: 'ok'
      devices: readonly SimObservedDevice[]
      onDisk?: readonly string[]
    }>
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
  // `unknown` on a timeout, within a few seconds: a poll waits for it.
  observe(): Promise<SimDeviceObservation>
  clone(source: string, name: string): Promise<SimOpOutcome>
  create(name: string, deviceType: string, runtime: string): Promise<SimOpOutcome>
  // Boot, apply and verify the slim profile and the project's defaults, shut down.
  prepare(udid: string, profile: SimSlimProfile): Promise<SimOpOutcome>
  boot(udid: string): Promise<SimOpOutcome>
  shutDown(udid: string): Promise<SimOpOutcome>
  // Terminate every user app running on the device (not only the holder's: whatever the holder
  // started is the holder's); the device stays booted.
  release(udid: string): Promise<SimOpOutcome>
  // Keep the UDID: shut down, erase, re-apply the slim profile and defaults, boot. The app comes
  // back through SimAppPort.reinstall once the core has seen the reset done.
  reset(udid: string, profile: SimSlimProfile): Promise<SimOpOutcome>
  delete(udid: string): Promise<SimOpOutcome>
}

/**
 * Read on every poll, and in a `lease` call when the last reading is older than
 * SIM_CAPACITY_FRESH_MS (the first lease after an idle spell, when nothing polled), so that call
 * can boot at once. 4b keeps it cheap: claude-acc's guard status, no device work.
 */
export type SimCapacityPort = { read(): Promise<SimCapacityReading> }

export type SimLivenessPort = {
  // `resolvedHere`: this runtime, or an earlier process of its profile, resolved the holder (the
  // lease's resolvedBy), so its panes and agent sessions are the ones to look in; any other
  // runtime answers notServedHere for them.
  holderFacts(holder: SimHolder, resolvedHere: boolean): Promise<SimHolderFacts>
  runtime(ref: SimProcessId): Promise<'live' | 'exited'>
  externalUse(): Promise<readonly string[]>
}

/** `notMacOS`: the pool runs only on macOS, and the store touches nothing elsewhere. */
export type SimRegistryRefusal = Readonly<{
  ok: false
  reason: 'registryUnreadable' | 'notMacOS'
  message: string
}>

export type SimRegistryStoreRead =
  | Readonly<{ ok: true; registry: SimRegistryFile; token: string }>
  | SimRegistryRefusal

export type SimRegistrySwap =
  | Readonly<{ ok: true; token: string }>
  | Readonly<{ ok: false; reason: 'conflict' }>
  | SimRegistryRefusal

/**
 * The Mac-wide registry. `swap` writes only when the file is still the one `token` named (under
 * the flock, temp file plus rename), else answers `conflict` and writes nothing; a lock held past
 * the store's wait is a `conflict` too (slow, not broken), so the caller re-reads and retries.
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
