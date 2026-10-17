// Test support: an in-memory Mac for the pool core. simctl's list, claude-acc's reading, holder
// liveness and the clock are plain fields a test sets; every step's registry is decoded with the
// contract's own SimRegistryFile, so the core never writes a file another runtime cannot read.
import type { SimHolder, SimHolderLiveness } from '../../../../shared/pod-sim/sim-holder'
import { simLeaseKey } from '../../../../shared/pod-sim/sim-holder'
import {
  simDeviceCountsTowardCap,
  type SimDeviceState
} from '../../../../shared/pod-sim/sim-lifecycle'
import type { SimBrake } from '../../../../shared/pod-sim/sim-pool-snapshot'
import {
  SimRegistryDevice,
  SimRegistryFile,
  SimRegistryLease
} from '../../../../shared/pod-sim/sim-registry'
import type {
  SimLeaseCaller,
  SimLeaseAnswer,
  SimPoolAnswer,
  SimLeaseRequest,
  SimPoolCommand,
  SimReleaseAnswer,
  SimTakeoverAnswer,
  SimVerbAnswer
} from './sim-pool-commands'
import { SIM_POOL_DEFAULTS, type SimPoolConfig } from './sim-pool-config'
import {
  EMPTY_SIM_POOL_MEMORY,
  type SimPoolDevice,
  type SimPoolEffect,
  type SimPoolLease,
  type SimPoolMemory,
  type SimPoolRegistry,
  type SimPoolTrace
} from './sim-pool-draft'
import type { SimCapacityReading, SimObservedDevice, SimRuntime } from './sim-pool-ports'
import { simPoolStep, type SimPoolStepResult } from './sim-pool-step'

export const SELF: SimRuntime = { pid: 70110, startedAt: 1760599900, profile: 'pn-self' }
export const PEER: SimRuntime = { pid: 70220, startedAt: 1760599950, profile: 'pn-peer' }
export const T0 = 1_760_600_000_000
export const ROOT = '/Users/dev/portivo-wt/maps'
export const IPHONE = 'iPhone 16 Pro'

export function udid(n: number): string {
  return `0000${String(n).padStart(4, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`
}

export function agent(pid: number, name?: string): SimHolder {
  const suffix = name ? `/${name}` : ''
  return {
    kind: 'agent',
    id: `agent:claude:${pid}:1760600000${suffix}`,
    agent: 'claude',
    pid,
    startedAt: 1_760_600_000,
    ...(name ? { name } : {})
  }
}

export function callerOf(holder: SimHolder, worktreeRoot = ROOT): SimLeaseCaller {
  return { key: simLeaseKey(holder.id, worktreeRoot), holder, worktreeRoot }
}

export type DeviceSpec = {
  state?: SimDeviceState
  role?: 'golden' | 'pool'
  deviceType?: string
  affinity?: string
  name?: string
}

function deepFrozen<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) {
      deepFrozen(child)
    }
  }
  return value
}

/** Change detection compares only the contract's fields, so the core may write no other. */
function onlyContractFields(rows: readonly object[], shape: object, what: string): void {
  for (const row of rows) {
    const stray = Object.keys(row).find((field) => !(field in shape))
    if (stray) {
      throw new Error(`the core wrote ${what}.${stray}, a field the contract does not name`)
    }
  }
}

export class PoolWorld {
  registry: SimPoolRegistry = { version: 1, updatedAt: 0, devices: [], leases: [] }
  memory: SimPoolMemory = structuredClone(EMPTY_SIM_POOL_MEMORY)
  mono = 1_000_000
  wall = T0
  // powerMonitor's suspends so far, and whether the last one has not resumed yet.
  suspends = 0
  suspended = false
  self = SELF
  config: SimPoolConfig
  openCalls = new Set<string>()
  // simctl's list of Pod's device set; `foreign` are devices in it the registry does not list.
  observed = new Map<string, SimObservedDevice>()
  verdict: 'ok' | 'unknown' = 'ok'
  capacity: { -readonly [Key in keyof SimCapacityReading]?: SimCapacityReading[Key] } & {
    -readonly [Key in Exclude<keyof SimCapacityReading, 'measuredAt'>]: SimCapacityReading[Key]
  }
  liveness: Record<string, SimHolderLiveness> = {}
  runtimes: Record<string, 'live' | 'exited'> = {}
  externalUse: string[] = []
  effects: SimPoolEffect[] = []
  last: SimPoolStepResult | null = null
  // Every move the core made, in order, across all steps.
  traces: SimPoolTrace[] = []
  private nextId = 1

  constructor(
    options: {
      cap?: number
      brake?: SimBrake
      outside?: number
      config?: Partial<SimPoolConfig>
    } = {}
  ) {
    this.config = {
      namePrefix: 'Portivo-',
      ...SIM_POOL_DEFAULTS,
      deviceTypes: { iphone: { deviceType: IPHONE, runtime: 'iOS 26.5' } },
      ...options.config
    }
    this.capacity = {
      source: 'claudeAcc',
      cap: options.cap ?? 2,
      outsideBooted: options.outside ?? 0,
      agentsInUse: 'unknown',
      brake: options.brake ?? 'calm'
    }
  }

  device(n: number, spec: DeviceSpec = {}): string {
    const id = udid(n)
    const state = spec.state ?? 'shutdown'
    const name =
      spec.name ?? (spec.role === 'golden' ? `Portivo-Pod-Golden-${n}` : `Portivo-Pod-${n}`)
    this.registry.devices.push({
      udid: id,
      name,
      role: spec.role ?? 'pool',
      deviceType: spec.deviceType ?? IPHONE,
      runtime: 'iOS 26.5',
      createdAt: T0 - 86_400_000,
      state,
      ...(spec.affinity ? { affinity: spec.affinity } : {})
    })
    const booted = simDeviceCountsTowardCap(state) && state !== 'preparing'
    this.observed.set(id, { udid: id, name, state: booted ? 'booted' : 'shutdown' })
    return id
  }

  /** A lease written by some runtime before this one looked (a restart, the other runtime). */
  addLease(
    holder: SimHolder,
    spec: Partial<SimPoolLease> & Pick<SimPoolLease, 'state'>,
    root = ROOT
  ): SimPoolLease {
    const lease: SimPoolLease = {
      leaseId: `sl_x${(this.nextId++).toString(36).padStart(4, '0')}`,
      key: simLeaseKey(holder.id, root),
      holder,
      worktreeRoot: root,
      since: this.wall - 600_000,
      lastActivity: this.wall - 60_000,
      wants: { deviceClass: 'iphone' },
      servedBy: this.self,
      ...spec
    }
    this.registry.leases.push(lease)
    return lease
  }

  /**
   * Time passes with the Mac awake: however long the gap between two steps, no sleep signal came
   * (a sleep sets `suspends`, sim-pool-clock.test.ts).
   */
  advance(ms: number): void {
    this.mono += ms
    this.wall += ms
  }

  now() {
    return { mono: this.mono, wall: this.wall, suspends: this.suspends, suspended: this.suspended }
  }

  step(command: SimPoolCommand): SimPoolStepResult {
    // Frozen input: an in-place edit of anything the draft shares with it throws here.
    const state = { registry: structuredClone(this.registry), memory: structuredClone(this.memory) }
    const result = simPoolStep(deepFrozen(state), command, {
      now: this.now(),
      self: this.self,
      config: this.config,
      openCalls: this.openCalls,
      ids: {
        leaseId: () => `sl_${(this.nextId++).toString(36).padStart(4, '0')}`,
        deviceId: () => udid(9000 + this.nextId++)
      }
    })
    SimRegistryFile.parse(result.registry)
    onlyContractFields(result.registry.devices, SimRegistryDevice.shape, 'device')
    onlyContractFields(result.registry.leases, SimRegistryLease.shape, 'lease')
    this.traces.push(...result.trace)
    this.registry = result.registry
    this.memory = result.memory
    this.effects = [...result.effects]
    this.last = result
    return result
  }

  poll(): SimPoolStepResult {
    return this.step({
      kind: 'poll',
      observation: {
        at: this.now(),
        devices:
          this.verdict === 'ok'
            ? { verdict: 'ok', devices: [...this.observed.values()] }
            : { verdict: 'unknown', why: 'simctl timed out' },
        capacity: { ...this.capacity, measuredAt: this.capacity.measuredAt ?? this.wall },
        liveness: { ...this.liveness },
        runtimes: { ...this.runtimes },
        externalUse: [...this.externalUse]
      }
    })
  }

  lease(holder: SimHolder, extra: Partial<SimLeaseRequest> = {}): SimLeaseAnswer {
    const request: SimLeaseRequest = { ...callerOf(holder, extra.worktreeRoot), ...extra }
    return this.answer('lease', this.step({ kind: 'lease', request }))
  }

  waitMine(holder: SimHolder, root = ROOT): SimLeaseAnswer {
    return this.answer('lease', this.step({ kind: 'waitMine', caller: callerOf(holder, root) }))
  }

  verb(holder: SimHolder, access: 'read' | 'input' = 'input', root = ROOT): SimVerbAnswer {
    const command = { kind: 'verb', caller: callerOf(holder, root), verb: 'tap', access } as const
    return this.answer('verb', this.step(command))
  }

  reset(holder: SimHolder, scope: 'app' | 'device', root = ROOT): SimVerbAnswer {
    return this.answer('verb', this.step({ kind: 'reset', caller: callerOf(holder, root), scope }))
  }

  release(holder: SimHolder, root = ROOT): SimReleaseAnswer {
    return this.answer('release', this.step({ kind: 'release', caller: callerOf(holder, root) }))
  }

  takeover(leaseId: string): SimTakeoverAnswer {
    return this.answer('takeover', this.step({ kind: 'takeover', leaseId }))
  }

  /** Completes the device's op in flight as simctl would, and updates simctl's list to match. */
  finish(
    id: string,
    outcome: { ok: true; udid?: string } | { ok: false; message: string } = { ok: true }
  ): SimPoolStepResult {
    const device = this.found(id)
    const op = device.op
    if (!op) {
      throw new Error(`no op in flight on ${device.name}`)
    }
    const real =
      outcome.ok && (op.kind === 'clone' || op.kind === 'create') ? udid(5000 + this.nextId++) : id
    if (outcome.ok) {
      const after = {
        boot: 'booted',
        reset: 'booted',
        release: 'booted',
        shutDown: 'shutdown',
        prepare: 'shutdown',
        clone: 'shutdown',
        create: 'shutdown',
        delete: null
      } as const
      const state = after[op.kind]
      if (state === null) {
        this.observed.delete(id)
      } else {
        this.observed.set(real, { udid: real, name: device.name, state })
      }
    }
    const done = outcome.ok && real !== id ? { ok: true as const, udid: real } : outcome
    return this.step({ kind: 'opFinished', udid: id, op, outcome: done })
  }

  /** simctl answering every op in flight at once, until none is left. */
  settleOps(): void {
    for (let round = 0; round < 10; round += 1) {
      const busy = this.registry.devices.find((device) => device.op)
      if (!busy) {
        return
      }
      this.finish(busy.udid)
    }
  }

  found(id: string): SimPoolDevice {
    const device = this.registry.devices.find((candidate) => candidate.udid === id)
    if (!device) {
      throw new Error(`no device ${id}`)
    }
    return device
  }

  named(name: string): SimPoolDevice | undefined {
    return this.registry.devices.find((candidate) => candidate.name === name)
  }

  leaseOf(holder: SimHolder, root = ROOT): SimPoolLease | undefined {
    return this.registry.leases.find((lease) => lease.key === simLeaseKey(holder.id, root))
  }

  effectKinds(): string[] {
    return this.effects.map((effect) =>
      'udid' in effect ? `${effect.kind} ${effect.udid}` : `${effect.kind} ${effect.leaseId}`
    )
  }

  private answer<Kind extends 'lease' | 'verb' | 'release' | 'takeover'>(
    kind: Kind,
    result: SimPoolStepResult
  ): AnswerOf<Kind> {
    const answer: SimPoolAnswer = result.answer
    if (answer.kind !== kind) {
      throw new Error(`expected a ${kind} answer, got ${answer.kind}`)
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: kind was checked just above.
    return answer.answer as AnswerOf<Kind>
  }
}

type AnswerOf<Kind> = Extract<SimPoolAnswer, { kind: Kind; answer: unknown }>['answer']
