// Fork-only (Pod): runs the pure core against the real world through its ports. Each command is
// one read of the Mac-wide registry, one pure step and, when the step changed it, one
// compare-and-swap; a swap that loses to the other runtime re-reads and steps again, and the lost
// step's effects are dropped unseen. Commands of one runtime run one at a time. Effects go out in
// the step's order (lease files first), and each device op's outcome comes back as a command.
//
// Cadence: a step asks for the next one at `wakeAt` (a window falling due); calls, releases and op
// outcomes step at once. Only what has no push is polled: holder liveness and claude-acc's reading
// every SIM_POOL_POLL_MS while anything is leased or booted, simctl's list and the argv scan every
// SIM_POOL_LIST_MS. Nothing leased and nothing booted: no timer at all, so the first `lease` after
// that reads claude-acc itself and can boot in the same call.
//
// 4b feeds the clock port's sleep signal from Electron's powerMonitor `suspend` and `resume`
// (event names checked against electron.d.ts of the pinned Electron 45; agent-awake-service.ts
// listens to `resume` already): see SimClockReading.
//
// What the world does slowly or wrongly stays out of the queue: claude-acc's reading for a `lease`
// is taken before the call joins it (one read shared by every call that needs one, and an unknown
// answer kept a few seconds), so a slow guard never holds another holder's tap. A device op whose
// result cannot be written is written again (finishOp ignores a result its op no longer matches),
// and one that failed across a sleep runs once more awake: its tool's timer ran on through the
// sleep (Node's clock does), so the failure says nothing about the device.
import type { SimRegistryFile } from '../../../../shared/pod-sim/sim-registry'
import { simHolderLiveness } from '../leases/sim-holder-liveness'
import type { SimPoolAnswer, SimPoolCommand } from './sim-pool-commands'
import type { SimPoolConfig } from './sim-pool-config'
import { capacityIsFresh } from './sim-pool-capacity'
import {
  EMPTY_SIM_POOL_MEMORY,
  runtimeKey,
  sameRuntime,
  seesHolderOf,
  type SimPoolEffect,
  type SimPoolMemory
} from './sim-pool-draft'
import type {
  SimAppPort,
  SimCapacityPort,
  SimCapacityReading,
  SimClock,
  SimClockReading,
  SimDeviceDriver,
  SimDeviceObservation,
  SimIdSource,
  SimLeaseFilePort,
  SimLivenessPort,
  SimOpOutcome,
  SimRegistryStore,
  SimRuntime,
  SimWaiterPort
} from './sim-pool-ports'
import { simPoolStep } from './sim-pool-step'
import { simPoolPolling } from './sim-pool-windows'

/** Liveness of a holder has no push (4b may add kqueue NOTE_EXIT); claude-acc measures every 2 s. */
export const SIM_POOL_POLL_MS = 5_000
/** simctl list and a process scan cost tens of ms of CPU: twice a minute, not every poll. */
export const SIM_POOL_LIST_MS = 30_000
const SWAP_ATTEMPTS = 8
/** An unknown or failed reading is not asked again sooner: claude-acc's CLI may take 4 s. */
export const SIM_CAPACITY_RETRY_MS = 5_000
/** Waits before writing a device op's result again; past the last, the op's deadline decides. */
const RESULT_RETRY_MS: readonly number[] = [500, 2_000, 8_000, 30_000]

export type SimPoolCoordinatorOptions = Readonly<{ resultRetryMs?: readonly number[] }>

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
  | Readonly<{
      ok: false
      reason: 'registryUnreadable' | 'notMacOS' | 'contention'
      message: string
    }>

/** How often to poll for this registry: only while something is held or booted. */
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
  private capacityAsk: { reading: Promise<SimCapacityReading>; settledAt: number | null } | null =
    null
  private readonly resultRetryMs: readonly number[]

  constructor(
    private readonly ports: SimPoolPorts,
    private readonly config: SimPoolConfig,
    private readonly self: SimRuntime,
    options: SimPoolCoordinatorOptions = {}
  ) {
    this.resultRetryMs = options.resultRetryMs ?? RESULT_RETRY_MS
  }

  async run(command: SimPoolCommand): Promise<SimPoolRun> {
    const ready = await this.withCapacity(command)
    const next = this.queue.then(() => this.step(ready))
    this.queue = next.catch(() => undefined)
    return next
  }

  /**
   * A `lease` after an idle spell (no poll, so claude-acc's last reading is stale) reads it for
   * the call: one cheap port read instead of `waitingFor: measurement` until the next poll.
   */
  private async withCapacity(command: SimPoolCommand): Promise<SimPoolCommand> {
    const now = this.ports.clock.now()
    if (command.kind !== 'lease' || capacityIsFresh(this.memory.observation?.capacity, now.wall)) {
      return command
    }
    const asked = this.capacityAsk
    const recent =
      asked && (asked.settledAt === null || now.mono - asked.settledAt < SIM_CAPACITY_RETRY_MS)
    return { ...command, capacity: await (recent ? asked.reading : this.askCapacity()) }
  }

  private askCapacity(): Promise<SimCapacityReading> {
    const ask: { reading: Promise<SimCapacityReading>; settledAt: number | null } = {
      reading: this.ports.capacity.read(),
      settledAt: null
    }
    this.capacityAsk = ask
    void ask.reading
      .finally(() => {
        ask.settledAt = this.ports.clock.now().mono
      })
      .catch(() => undefined)
    return ask.reading
  }

  private async step(command: SimPoolCommand): Promise<SimPoolRun> {
    for (let attempt = 0; attempt < SWAP_ATTEMPTS; attempt += 1) {
      const read = await this.ports.store.read()
      if (!read.ok) {
        return { ok: false, reason: read.reason, message: read.message }
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
          return { ok: false, reason: swap.reason, message: swap.message }
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
      return { ok: false, reason: read.reason, message: read.message }
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
      // Only the runtime that resolved the holder, or that Pod restarted, can see its panes and
      // sessions; serving the lease (as an adopter does) is not enough.
      const facts = await this.ports.liveness.holderFacts(
        lease.holder,
        seesHolderOf(lease.resolvedBy ?? lease.servedBy, this.self)
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
    const outcome = await this.performAwake(effect)
    const finished = { kind: 'opFinished', udid: effect.udid, op: effect.op, outcome } as const
    for (const wait of [0, ...this.resultRetryMs]) {
      if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait))
      }
      const result = await this.run(finished)
      if (result.ok) {
        await this.dispatch(result.effects)
        return
      }
    }
  }

  /** The op, and once more if it failed while the Mac slept through part of it. */
  private async performAwake(
    effect: Extract<SimPoolEffect, { op: unknown }>
  ): Promise<SimOpOutcome> {
    const before = this.ports.clock.now().suspends
    const outcome = await this.performSafely(effect)
    const after = this.ports.clock.now()
    if (outcome.ok || (after.suspends === before && !after.suspended)) {
      return outcome
    }
    return this.performSafely(effect)
  }

  private performSafely(effect: Extract<SimPoolEffect, { op: unknown }>): Promise<SimOpOutcome> {
    return this.perform(effect).catch((error: unknown): SimOpOutcome => ({
      ok: false,
      message: String(error)
    }))
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
