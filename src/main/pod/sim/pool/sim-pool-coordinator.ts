// Fork-only (Pod): runs the pure core against the real world through its ports. Each command is
// one read of the Mac-wide registry, one pure step and, when the step changed it, one
// compare-and-swap; a swap that loses to the other runtime re-reads and steps again, and the lost
// step's effects are dropped unseen. Commands of one runtime run one at a time. Effects go out in
// the step's order (lease files first), and each device op's outcome comes back as a command.
//
// Cadence: a step asks for the next one at `wakeAt` (a window falling due); calls, releases and op
// outcomes step at once. Only what has no push is polled: holder liveness and claude-acc's reading
// every SIM_POOL_POLL_MS while anything is leased or booted, simctl's list and the argv scan every
// SIM_POOL_LIST_MS. Nothing leased and nothing booted: no timer at all.
import type { SimRegistryFile } from '../../../../shared/pod-sim/sim-registry'
import { simHolderLiveness } from '../leases/sim-holder-liveness'
import type { SimPoolAnswer, SimPoolCommand } from './sim-pool-commands'
import type { SimPoolConfig } from './sim-pool-config'
import {
  EMPTY_SIM_POOL_MEMORY,
  runtimeKey,
  sameRuntime,
  type SimPoolEffect,
  type SimPoolMemory
} from './sim-pool-draft'
import type {
  SimAppPort,
  SimCapacityPort,
  SimClock,
  SimClockReading,
  SimDeviceDriver,
  SimDeviceObservation,
  SimIdSource,
  SimLeaseFilePort,
  SimLivenessPort,
  SimOpOutcome,
  SimRegistryStore,
  SimProcessId,
  SimWaiterPort
} from './sim-pool-ports'
import { simPoolStep } from './sim-pool-step'
import { simPoolPolling } from './sim-pool-windows'

/** Liveness of a holder has no push (4b may add kqueue NOTE_EXIT); claude-acc measures every 2 s. */
export const SIM_POOL_POLL_MS = 5_000
/** simctl list and a process scan cost tens of ms of CPU: twice a minute, not every poll. */
export const SIM_POOL_LIST_MS = 30_000
const SWAP_ATTEMPTS = 8

export type SimPoolPorts = Readonly<{
  store: SimRegistryStore
  clock: SimClock
  ids: SimIdSource
  devices: SimDeviceDriver
  capacity: SimCapacityPort
  liveness: SimLivenessPort
  leaseFiles: SimLeaseFilePort
  waiters: SimWaiterPort
  apps: SimAppPort
}>

export type SimPoolRun =
  | Readonly<{
      ok: true
      answer: SimPoolAnswer
      effects: readonly SimPoolEffect[]
      wakeAt: number | null
    }>
  | Readonly<{ ok: false; reason: 'registryUnreadable' | 'contention'; message: string }>

/**
 * How often to poll for this registry: only while something is held or booted. The core relies on
 * it: a longer gap between its steps while polling is time no rule watched (a sleep).
 */
export function simPoolPollMs(registry: SimRegistryFile): number | null {
  return simPoolPolling(registry) ? SIM_POOL_POLL_MS : null
}

export class SimPoolCoordinator {
  /** Lease ids of waiting calls (`lease --wait`, `wait --mine`) this runtime holds open now. */
  readonly openCalls = new Set<string>()
  lastEffects: readonly SimPoolEffect[] = []
  wakeAt: number | null = null
  private memory: SimPoolMemory = structuredClone(EMPTY_SIM_POOL_MEMORY)
  private queue: Promise<unknown> = Promise.resolve()
  private readonly pending = new Set<Promise<void>>()
  private listing: {
    at: SimClockReading
    devices: SimDeviceObservation
    externalUse: readonly string[]
  } | null = null

  constructor(
    private readonly ports: SimPoolPorts,
    private readonly config: SimPoolConfig,
    private readonly self: SimProcessId
  ) {}

  run(command: SimPoolCommand): Promise<SimPoolRun> {
    const next = this.queue.then(() => this.step(command))
    this.queue = next.catch(() => undefined)
    return next
  }

  private async step(command: SimPoolCommand): Promise<SimPoolRun> {
    for (let attempt = 0; attempt < SWAP_ATTEMPTS; attempt += 1) {
      const read = await this.ports.store.read()
      if (!read.ok) {
        return { ok: false, reason: 'registryUnreadable', message: read.message }
      }
      const result = simPoolStep({ registry: read.registry, memory: this.memory }, command, {
        now: this.ports.clock.now(),
        self: this.self,
        config: this.config,
        openCalls: this.openCalls,
        ids: this.ports.ids
      })
      if (result.changed) {
        const swap = await this.ports.store.swap(read.token, result.registry)
        if (!swap.ok && swap.reason === 'conflict') {
          continue
        }
        if (!swap.ok) {
          return { ok: false, reason: 'registryUnreadable', message: swap.message }
        }
      }
      this.memory = result.memory
      this.lastEffects = result.effects
      this.wakeAt = result.wakeAt
      return { ok: true, answer: result.answer, effects: result.effects, wakeAt: result.wakeAt }
    }
    return {
      ok: false,
      reason: 'contention',
      message: `the simulator registry changed under ${SWAP_ATTEMPTS} attempts in a row`
    }
  }

  /** One observation (simctl's list only when due), then a poll step. */
  async poll(options: { relist?: boolean } = {}): Promise<SimPoolRun> {
    const read = await this.ports.store.read()
    if (!read.ok) {
      return { ok: false, reason: 'registryUnreadable', message: read.message }
    }
    const at = this.ports.clock.now()
    if (options.relist || !this.listing || at.mono - this.listing.at.mono >= SIM_POOL_LIST_MS) {
      const [devices, externalUse] = await Promise.all([
        this.ports.devices.observe(),
        this.ports.liveness.externalUse()
      ])
      this.listing = { at, devices, externalUse }
    }
    const capacity = await this.ports.capacity.read()
    const liveness: Record<string, ReturnType<typeof simHolderLiveness>> = {}
    for (const lease of read.registry.leases) {
      // Only the runtime that resolved the holder can see its panes and sessions; serving the
      // lease (as an adopter does) is not enough.
      const facts = await this.ports.liveness.holderFacts(
        lease.holder,
        sameRuntime(lease.resolvedBy ?? lease.servedBy, this.self)
      )
      liveness[lease.leaseId] = simHolderLiveness(lease.holder, facts)
    }
    const runtimes: Record<string, 'live' | 'exited'> = {}
    const refs = [
      ...read.registry.leases.map((lease) => lease.servedBy),
      ...read.registry.devices.flatMap((device) => (device.op ? [device.op.by] : []))
    ]
    for (const ref of refs) {
      if (!sameRuntime(ref, this.self) && !(runtimeKey(ref) in runtimes)) {
        runtimes[runtimeKey(ref)] = await this.ports.liveness.runtime(ref)
      }
    }
    const { devices, externalUse } = this.listing
    return this.run({
      kind: 'poll',
      observation: { at: this.listing.at, devices, capacity, liveness, runtimes, externalUse }
    })
  }

  /** Lease files are written before device work starts; each op's outcome steps the core. */
  async dispatch(effects: readonly SimPoolEffect[]): Promise<void> {
    for (const effect of effects) {
      if (effect.kind === 'writeLeaseFile') {
        await this.ports.leaseFiles.write(effect.udid, effect.file)
      } else if (effect.kind === 'removeLeaseFile') {
        await this.ports.leaseFiles.remove(effect.udid)
      }
    }
    for (const effect of effects) {
      if (effect.kind === 'notifyWaiter') {
        this.ports.waiters.notify(effect.leaseId)
      } else if (effect.kind === 'resetApp') {
        this.track(this.ports.apps.reset(effect.udid, effect.leaseId))
      } else if (effect.kind === 'reinstallApp') {
        this.track(this.ports.apps.reinstall(effect.udid, effect.leaseId))
      } else if (effect.kind !== 'writeLeaseFile' && effect.kind !== 'removeLeaseFile') {
        this.track(this.runOp(effect))
      }
    }
  }

  /** Resolves once every op started so far, and the work its outcome led to, is done. */
  async settled(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all(this.pending)
    }
  }

  private track(work: Promise<void>): void {
    const tracked = work.catch(() => undefined).finally(() => this.pending.delete(tracked))
    this.pending.add(tracked)
  }

  private async runOp(effect: Extract<SimPoolEffect, { op: unknown }>): Promise<void> {
    const outcome = await this.perform(effect).catch((error: unknown): SimOpOutcome => ({
      ok: false,
      message: String(error)
    }))
    const result = await this.run({ kind: 'opFinished', udid: effect.udid, op: effect.op, outcome })
    if (result.ok) {
      await this.dispatch(result.effects)
    }
  }

  private perform(effect: Extract<SimPoolEffect, { op: unknown }>): Promise<SimOpOutcome> {
    const driver: SimDeviceDriver = this.ports.devices
    switch (effect.kind) {
      case 'clone':
        return driver.clone(effect.source, effect.name)
      case 'create':
        return driver.create(effect.name, effect.deviceType, effect.runtime)
      case 'prepare':
        return driver.prepare(effect.udid, effect.profile)
      case 'boot':
        return driver.boot(effect.udid)
      case 'shutDown':
        return driver.shutDown(effect.udid)
      case 'release':
        return driver.release(effect.udid)
      case 'reset':
        return driver.reset(effect.udid, effect.profile)
      case 'delete':
        return driver.delete(effect.udid)
    }
  }
}
