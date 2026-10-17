// Test support: in-memory adapters behind the pool's ports, shared by two runtimes on one "Mac".
// The store's read and swap yield to the event loop, so two runtimes stepping at once interleave
// as they would on one flocked file.
import type { SimHolder } from '../../../../shared/pod-sim/sim-holder'
import { simDeviceCountsTowardCap } from '../../../../shared/pod-sim/sim-lifecycle'
import type { SimRegistryFile } from '../../../../shared/pod-sim/sim-registry'
import type { SimHolderFacts } from '../leases/sim-holder-liveness'
import type { SimPoolPorts } from './sim-pool-coordinator'
import type { SimRegistryStoreRead, SimRegistrySwap, SimProcessId } from './sim-pool-ports'
import { T0, udid } from './sim-pool.test-support'

class FakeStore {
  swaps: string[] = []
  private revision = 1
  private damaged: string | null = null
  private failing = 0

  constructor(
    private registry: SimRegistryFile,
    private readonly calls: string[]
  ) {}

  async read(): Promise<SimRegistryStoreRead> {
    await Promise.resolve()
    this.calls.push('read')
    if (this.damaged) {
      return { ok: false, reason: 'registryUnreadable', message: this.damaged }
    }
    return { ok: true, registry: structuredClone(this.registry), token: String(this.revision) }
  }

  async swap(token: string, next: SimRegistryFile): Promise<SimRegistrySwap> {
    await Promise.resolve()
    this.calls.push('swap')
    if (this.failing > 0) {
      this.failing -= 1
      this.swaps.push('failed')
      return { ok: false, reason: 'registryUnreadable', message: 'disk full' }
    }
    if (token !== String(this.revision)) {
      this.swaps.push('conflict')
      return { ok: false, reason: 'conflict' }
    }
    this.swaps.push('ok')
    this.revision += 1
    this.registry = structuredClone(next)
    return { ok: true, token: String(this.revision) }
  }

  current(): SimRegistryFile {
    return this.registry
  }

  damage(message: string): void {
    this.damaged = message
  }

  /** The next `count` swaps fail as a write that could not happen (a full disk). */
  failSwaps(count: number): void {
    this.failing = count
  }
}

export type FakePorts = {
  store: FakeStore
  calls: string[]
  notified: Map<number, string[]>
  forRuntime(self: SimProcessId): SimPoolPorts
  reset(): void
  // Time passes with no step at all (nothing held or booted, so no poll).
  idle(ms: number): void
}

/** What a runtime sees of a holder and of another runtime; every holder lives by default. */
export type FakeWorld = Readonly<{
  holderFacts?: (self: SimProcessId, holder: SimHolder, resolvedHere: boolean) => SimHolderFacts
  runtime?: (ref: SimProcessId) => 'live' | 'exited'
}>

export function fakePorts(registry: SimRegistryFile, world: FakeWorld = {}): FakePorts {
  const calls: string[] = []
  const store = new FakeStore(registry, calls)
  const notified = new Map<number, string[]>()
  let tick = 0
  let ids = 1
  const done = async (call: string) => {
    calls.push(call)
    await Promise.resolve()
    return { ok: true as const }
  }
  return {
    store,
    calls,
    notified,
    reset: () => {
      calls.length = 0
      store.swaps.length = 0
    },
    idle: (ms) => {
      tick += ms
    },
    forRuntime: (self) => ({
      store,
      clock: {
        now: () => ({ mono: 1_000_000 + tick, wall: T0 + tick++, suspends: 0, suspended: false })
      },
      ids: {
        leaseId: () => `sl_${self.pid.toString(36)}${(ids++).toString(36).padStart(3, '0')}`,
        deviceId: () => udid(7000 + ids++)
      },
      devices: {
        observe: async () => ({
          verdict: 'ok',
          devices: store.current().devices.map((device) => ({
            udid: device.udid,
            name: device.name,
            state:
              device.state && simDeviceCountsTowardCap(device.state) && device.state !== 'preparing'
                ? 'booted'
                : 'shutdown'
          }))
        }),
        clone: () => done('clone'),
        create: () => done('create'),
        prepare: (id) => done(`prepare ${id}`),
        boot: (id) => done(`boot ${id}`),
        shutDown: (id) => done(`shutDown ${id}`),
        release: (id) => done(`release ${id}`),
        reset: (id) => done(`reset ${id}`),
        delete: (id) => done(`delete ${id}`)
      },
      capacity: {
        read: async () => {
          calls.push('capacity')
          return {
            source: 'claudeAcc',
            cap: 2,
            outsideBooted: 0,
            agentsInUse: 0,
            brake: 'calm',
            measuredAt: T0 + tick
          }
        }
      },
      liveness: {
        holderFacts: async (holder, resolvedHere) =>
          world.holderFacts?.(self, holder, resolvedHere) ?? {
            process: { found: true, startedAt: holder.startedAt ?? 0 },
            session: 'present',
            terminal: 'open'
          },
        runtime: async (ref) => world.runtime?.(ref) ?? 'live',
        externalUse: async () => []
      },
      leaseFiles: {
        write: async (id) => {
          calls.push(`leaseFile ${id}`)
        },
        remove: async (id) => {
          calls.push(`removeLeaseFile ${id}`)
        }
      },
      waiters: {
        notify: (leaseId) => {
          notified.set(self.pid, [...(notified.get(self.pid) ?? []), leaseId])
        }
      },
      apps: {
        reset: async (id) => {
          calls.push(`resetApp ${id}`)
        },
        reinstall: async (id) => {
          calls.push(`reinstallApp ${id}`)
        }
      }
    })
  }
}
