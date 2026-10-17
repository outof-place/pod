// The coordinator when the world is slow or fails under it: claude-acc taking seconds to answer,
// a registry write that does not land, device work cut by a sleep.
import { describe, expect, it } from 'vitest'
import { simLeaseKey, type SimHolder } from '../../../../shared/pod-sim/sim-holder'
import type { SimRegistryFile } from '../../../../shared/pod-sim/sim-registry'
import { SimPoolCoordinator } from './sim-pool-coordinator'
import { fakePorts } from './sim-pool-coordinator.test-support'
import type { SimCapacityReading, SimClockReading, SimOpOutcome } from './sim-pool-ports'
import { agent, IPHONE, ROOT, SELF, T0, udid } from './sim-pool.test-support'

const HOLDER = agent(42001)
const CONFIG = {
  namePrefix: 'Portivo-',
  podCap: 2,
  idleMs: 30 * 60_000,
  warmMs: 10 * 60_000,
  claimMs: 180_000,
  maxDevicesPerClass: 4,
  deviceTypes: { iphone: { deviceType: IPHONE, runtime: 'iOS 26.5' } }
}
const NO_WAIT = { resultRetryMs: [0, 0, 0] }

/** One device held by HOLDER. */
function heldRegistry(): SimRegistryFile {
  return {
    version: 1,
    updatedAt: T0 - 60_000,
    devices: [
      {
        udid: udid(1),
        name: 'Portivo-Pod-1',
        role: 'pool',
        deviceType: IPHONE,
        runtime: 'iOS 26.5',
        createdAt: T0 - 86_400_000,
        state: 'leased'
      }
    ],
    leases: [
      {
        leaseId: 'sl_h001',
        key: simLeaseKey(HOLDER.id, ROOT),
        state: 'active',
        holder: HOLDER,
        worktreeRoot: ROOT,
        since: T0 - 600_000,
        lastActivity: T0 - 60_000,
        udid: udid(1),
        wants: { deviceClass: 'iphone' },
        servedBy: SELF
      }
    ]
  }
}

const caller = (holder: SimHolder) => ({
  key: simLeaseKey(holder.id, ROOT),
  holder,
  worktreeRoot: ROOT
})

const UNKNOWN: SimCapacityReading = {
  source: 'claudeAcc',
  cap: 'unknown',
  outsideBooted: 'unknown',
  agentsInUse: 'unknown',
  brake: 'unknown',
  measuredAt: null
}

describe('a slow claude-acc', () => {
  it('never holds a holder’s tap behind a lease waiting on its reading', async () => {
    const ports = fakePorts(heldRegistry())
    let reads = 0
    let answer: (reading: SimCapacityReading) => void = () => undefined
    const slow = new Promise<SimCapacityReading>((resolve) => {
      answer = resolve
    })
    const mine = new SimPoolCoordinator(
      {
        ...ports.forRuntime(SELF),
        capacity: {
          read: () => {
            reads += 1
            return slow
          }
        }
      },
      CONFIG,
      SELF
    )
    const waiting = [agent(42002), agent(42003), agent(42004)].map((holder) =>
      mine.run({ kind: 'lease', request: caller(holder) })
    )
    const tap = mine.run({ kind: 'verb', caller: caller(HOLDER), verb: 'tap', access: 'input' })
    const first = await Promise.race([
      tap.then(() => 'tap'),
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 200))
    ])
    expect(first).toBe('tap')
    // The three waiters asked once between them.
    expect(reads).toBe(1)
    answer(UNKNOWN)
    await Promise.all(waiting)
    // An unknown reading is remembered for a few seconds: the next lease does not ask again.
    await mine.run({ kind: 'lease', request: caller(agent(42005)) })
    expect(reads).toBe(1)
  })
})

describe('a device op’s result that does not reach the registry at once', () => {
  it('is written again, so the device is not failed and remade', async () => {
    const ports = fakePorts(heldRegistry())
    const mine = new SimPoolCoordinator(ports.forRuntime(SELF), CONFIG, SELF, NO_WAIT)
    // A trusted listing first: device work waits for one.
    await mine.poll()
    const released = await mine.run({ kind: 'release', caller: caller(HOLDER) })
    expect(released.ok && released.effects.map((effect) => effect.kind)).toContain('release')
    ports.store.failSwaps(2)
    await mine.dispatch(released.ok ? released.effects : [])
    await mine.settled()
    expect(ports.store.swaps.slice(-3)).toEqual(['failed', 'failed', 'ok'])
    expect(ports.store.current().devices[0]).toMatchObject({ state: 'ready' })
    expect(ports.store.current().devices[0].op).toBeUndefined()
    expect(ports.store.current().devices[0].failure).toBeUndefined()
  })
})

describe('device work cut short by a sleep', () => {
  function sleepyWorld(outcomes: SimOpOutcome[], sleeps: boolean) {
    const ports = fakePorts(heldRegistry())
    const base = ports.forRuntime(SELF)
    let suspends = 0
    let calls = 0
    const clock = {
      now: (): SimClockReading => ({ ...base.clock.now(), suspends, suspended: false })
    }
    const mine = new SimPoolCoordinator(
      {
        ...base,
        clock,
        devices: {
          ...base.devices,
          release: async () => {
            calls += 1
            if (sleeps && calls === 1) {
              // The Mac slept mid-op; the tool's timer ran out on wake.
              suspends += 1
            }
            return outcomes[calls - 1] ?? { ok: true }
          }
        }
      },
      CONFIG,
      SELF,
      NO_WAIT
    )
    return { ports, mine, calls: () => calls }
  }

  const TIMED_OUT: SimOpOutcome = { ok: false, message: 'simctl terminate ran past 40000 ms' }

  it('is done again on wake, not counted as the device failing', async () => {
    const { ports, mine, calls } = sleepyWorld([TIMED_OUT, { ok: true }], true)
    await mine.poll()
    const released = await mine.run({ kind: 'release', caller: caller(HOLDER) })
    await mine.dispatch(released.ok ? released.effects : [])
    await mine.settled()
    expect(calls()).toBe(2)
    expect(ports.store.current().devices[0]).toMatchObject({ state: 'ready' })
    expect(ports.store.current().devices[0].failure).toBeUndefined()
  })

  it('fails the device as before when no sleep came between', async () => {
    const { ports, mine, calls } = sleepyWorld([TIMED_OUT, { ok: true }], false)
    await mine.poll()
    const released = await mine.run({ kind: 'release', caller: caller(HOLDER) })
    await mine.dispatch(released.ok ? released.effects : [])
    await mine.settled()
    expect(calls()).toBe(1)
    expect(ports.store.current().devices[0]).toMatchObject({ state: 'failed' })
  })
})
