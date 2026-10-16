import { describe, expect, it } from 'vitest'
import { simLeaseKey } from '../../../../shared/pod-sim/sim-holder'
import type { SimRegistryFile } from '../../../../shared/pod-sim/sim-registry'
import { SimPoolCoordinator } from './sim-pool-coordinator'
import { fakePorts, type FakePorts } from './sim-pool-coordinator.test-support'
import { agent, IPHONE, PEER, ROOT, SELF, T0, udid } from './sim-pool.test-support'

const W1 = agent(42001)
const W2 = agent(42002)
const CONFIG = {
  namePrefix: 'Portivo-',
  podCap: 2,
  idleMs: 30 * 60_000,
  warmMs: 10 * 60_000,
  maxDevicesPerClass: 4,
  deviceTypes: { iphone: { deviceType: IPHONE, runtime: 'iOS 26.5' } }
}

function waiting(holder: typeof W1, leaseId: string, since: number, servedBy: typeof SELF) {
  return {
    leaseId,
    key: simLeaseKey(holder.id, ROOT),
    state: 'waiting' as const,
    holder,
    worktreeRoot: ROOT,
    since,
    lastActivity: T0,
    queue: { position: 1, since, waitingFor: 'slot' as const },
    wants: { deviceClass: 'iphone' as const },
    servedBy
  }
}

function registryWithOneFreeDevice(): SimRegistryFile {
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
        state: 'ready'
      }
    ],
    // W2 joined later but its call reached this runtime; W1's call is held by the other one.
    leases: [waiting(W1, 'sl_w001', T0 - 30_000, PEER), waiting(W2, 'sl_w002', T0 - 20_000, SELF)]
  }
}

function twoRuntimes(): { mine: SimPoolCoordinator; peer: SimPoolCoordinator; ports: FakePorts } {
  const ports = fakePorts(registryWithOneFreeDevice())
  const mine = new SimPoolCoordinator(ports.forRuntime(SELF), CONFIG, SELF)
  const peer = new SimPoolCoordinator(ports.forRuntime(PEER), CONFIG, PEER)
  return { mine, peer, ports }
}

describe('two runtimes sharing one registry', () => {
  it('never assigns one device twice when both decide on the same revision', async () => {
    const { mine, peer, ports } = twoRuntimes()
    peer.openCalls.add('sl_w001')
    const [a, b] = await Promise.all([mine.poll(), peer.poll()])
    expect(a.ok && b.ok).toBe(true)
    const named = ports.store.current().leases.filter((lease) => lease.udid === udid(1))
    expect(named).toHaveLength(1)
    // The oldest waiter gets it, whichever runtime wrote first.
    expect(named[0]).toMatchObject({ leaseId: 'sl_w001', servedBy: PEER })
    expect(ports.store.swaps).toEqual(['ok', 'conflict', 'ok'])
  })

  it('discards the loser effects and answers the waiter the other runtime holds', async () => {
    const { mine, peer, ports } = twoRuntimes()
    peer.openCalls.add('sl_w001')
    const [, b] = await Promise.all([mine.poll(), peer.poll()])
    expect(ports.store.current().leases.find((lease) => lease.leaseId === 'sl_w001')?.state).toBe(
      'active'
    )
    expect(b.ok && b.effects.filter((effect) => effect.kind === 'notifyWaiter')).toEqual([
      { kind: 'notifyWaiter', leaseId: 'sl_w001' }
    ])
    await peer.dispatch(b.ok ? b.effects : [])
    expect(ports.notified.get(PEER.pid)).toEqual(['sl_w001'])
    expect(ports.notified.get(SELF.pid) ?? []).toEqual([])
  })

  it('turns its pool off on a registry it cannot read, and never writes it', async () => {
    const ports = fakePorts(registryWithOneFreeDevice())
    ports.store.damage('the file is not JSON')
    const mine = new SimPoolCoordinator(ports.forRuntime(SELF), CONFIG, SELF)
    expect(await mine.poll()).toMatchObject({ ok: false, reason: 'registryUnreadable' })
    expect(ports.store.swaps).toEqual([])
  })
})

describe('the warm hand-out', () => {
  it('reads once, swaps once and writes one lease file: no device work, no wait', async () => {
    const ports = fakePorts({ ...registryWithOneFreeDevice(), leases: [] })
    const mine = new SimPoolCoordinator(ports.forRuntime(SELF), CONFIG, SELF)
    await mine.poll()
    await mine.dispatch(mine.lastEffects)
    ports.reset()
    const result = await mine.run({
      kind: 'lease',
      request: { key: simLeaseKey(W1.id, ROOT), holder: W1, worktreeRoot: ROOT }
    })
    expect(result).toMatchObject({
      ok: true,
      answer: { kind: 'lease', answer: { status: 'ready' } }
    })
    await mine.dispatch(result.ok ? result.effects : [])
    expect(ports.calls).toEqual(['read', 'swap', `leaseFile ${udid(1)}`])
  })
})

describe('effects reach the adapters', () => {
  it('writes lease files before it starts device work, and feeds each outcome back', async () => {
    const ports = fakePorts({
      ...registryWithOneFreeDevice(),
      devices: [{ ...registryWithOneFreeDevice().devices[0], state: 'shutdown' }],
      leases: []
    })
    const mine = new SimPoolCoordinator(ports.forRuntime(SELF), CONFIG, SELF)
    await mine.poll()
    await mine.dispatch(mine.lastEffects)
    ports.reset()
    const result = await mine.run({
      kind: 'lease',
      request: { key: simLeaseKey(W1.id, ROOT), holder: W1, worktreeRoot: ROOT }
    })
    await mine.dispatch(result.ok ? result.effects : [])
    await mine.settled()
    expect(ports.calls.filter((call) => call !== 'read' && call !== 'swap')).toEqual([
      `leaseFile ${udid(1)}`,
      `boot ${udid(1)}`
    ])
    expect(ports.store.current().devices[0]).toMatchObject({ state: 'ready' })
    expect(ports.store.current().devices[0].op).toBeUndefined()
  })
})
