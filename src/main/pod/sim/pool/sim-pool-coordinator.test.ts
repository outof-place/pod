import { describe, expect, it } from 'vitest'
import { simLeaseKey, type SimHolder } from '../../../../shared/pod-sim/sim-holder'
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
  claimMs: 180_000,
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

  it('gives the device to the same waiter when the other runtime writes first', async () => {
    const { mine, peer, ports } = twoRuntimes()
    peer.openCalls.add('sl_w001')
    const [b, a] = await Promise.all([peer.poll(), mine.poll()])
    expect(ports.store.swaps.slice(0, 2)).toEqual(['ok', 'conflict'])
    const named = ports.store.current().leases.filter((lease) => lease.udid === udid(1))
    expect(named).toHaveLength(1)
    expect(named[0]).toMatchObject({ leaseId: 'sl_w001', state: 'active', servedBy: PEER })
    // The loser recomputed on the winner's file: it starts no device work and wakes nobody.
    expect(a.ok && a.effects.filter((effect) => effect.kind !== 'writeLeaseFile')).toEqual([])
    expect(b.ok && b.effects.filter((effect) => effect.kind === 'notifyWaiter')).toEqual([
      { kind: 'notifyWaiter', leaseId: 'sl_w001' }
    ])
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

describe('the first lease after a long idle', () => {
  it("reads claude-acc's capacity in the same call and starts the boot at once", async () => {
    const free = registryWithOneFreeDevice()
    const ports = fakePorts({
      ...free,
      devices: [{ ...free.devices[0], state: 'shutdown' }],
      leases: []
    })
    const mine = new SimPoolCoordinator(ports.forRuntime(SELF), CONFIG, SELF)
    await mine.poll()
    ports.idle(40 * 60_000)
    ports.reset()
    const result = await mine.run({
      kind: 'lease',
      request: { key: simLeaseKey(W1.id, ROOT), holder: W1, worktreeRoot: ROOT }
    })
    expect(result).toMatchObject({
      ok: true,
      answer: { kind: 'lease', answer: { status: 'waiting', waitingFor: 'device' } }
    })
    expect(result.ok && result.effects.map((effect) => effect.kind)).toContain('boot')
    expect(ports.calls).toEqual(['capacity', 'read', 'swap'])
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

describe('a runtime that adopts the leases of one that crashed', () => {
  const CRASHED = { pid: 60001, startedAt: 1760500000, profile: 'pod' }
  const PANE = { kind: 'terminal' as const, id: 'terminal:term_7f3a', terminalHandle: 'term_7f3a' }
  const SESSION = {
    kind: 'agentSession' as const,
    id: 'session:5d1c9a2e',
    sessionId: '5d1c9a2e',
    agent: 'claude'
  }

  function active(holder: SimHolder, leaseId: string, device: number) {
    return {
      leaseId,
      key: simLeaseKey(holder.id, ROOT),
      state: 'active' as const,
      holder,
      worktreeRoot: ROOT,
      since: T0 - 600_000,
      lastActivity: T0 - 60_000,
      udid: udid(device),
      wants: { deviceClass: 'iphone' as const },
      servedBy: CRASHED
    }
  }

  function crashedRegistry(): SimRegistryFile {
    const device = registryWithOneFreeDevice().devices[0]
    return {
      version: 1,
      updatedAt: T0 - 60_000,
      devices: [1, 2].map((n) => ({
        ...device,
        udid: udid(n),
        name: `Portivo-Pod-${n}`,
        state: 'leased' as const
      })),
      leases: [active(PANE, 'sl_p001', 1), active(SESSION, 'sl_s001', 2)]
    }
  }

  // This runtime's own panes and sessions: none of the crashed runtime's.
  const probe = {
    holderFacts: (_self: unknown, _holder: SimHolder, resolvedHere: boolean) =>
      resolvedHere
        ? ({ process: { found: false }, session: 'ended', terminal: 'closed' } as const)
        : ({ process: 'unknown', session: 'notServedHere', terminal: 'notServedHere' } as const),
    runtime: (ref: { pid: number }) => (ref.pid === CRASHED.pid ? 'exited' : 'live')
  } as const

  it('keeps them through its liveness polls: it cannot see the panes and sessions they live in', async () => {
    const ports = fakePorts(crashedRegistry(), probe)
    const mine = new SimPoolCoordinator(ports.forRuntime(SELF), CONFIG, SELF)
    for (let poll = 0; poll < 3; poll += 1) {
      expect(await mine.poll()).toMatchObject({ ok: true })
    }
    expect(ports.store.current().leases).toMatchObject([
      { leaseId: 'sl_p001', state: 'active', servedBy: SELF },
      { leaseId: 'sl_s001', state: 'active', servedBy: SELF }
    ])
  })

  it('releases closed panes within one poll when it is the same Pod restarted', async () => {
    const ports = fakePorts(crashedRegistry(), probe)
    const restarted = { pid: 70300, startedAt: 1760599990, profile: CRASHED.profile }
    const pod = new SimPoolCoordinator(ports.forRuntime(restarted), CONFIG, restarted)
    expect(await pod.poll()).toMatchObject({ ok: true })
    expect(ports.store.current().leases).toEqual([])
    expect(ports.store.current().tombstones?.map((ended) => ended.ended.reason)).toEqual([
      'holderExited',
      'holderExited'
    ])
  })

  it('still releases a holder it resolved itself once its pane closes', async () => {
    const ports = fakePorts({ ...crashedRegistry(), leases: [] }, probe)
    const mine = new SimPoolCoordinator(ports.forRuntime(SELF), CONFIG, SELF)
    await mine.poll()
    await mine.run({
      kind: 'lease',
      request: { key: simLeaseKey(PANE.id, ROOT), holder: PANE, worktreeRoot: ROOT }
    })
    await mine.poll()
    expect(ports.store.current().leases).toEqual([])
    expect(ports.store.current().tombstones).toMatchObject([
      { key: simLeaseKey(PANE.id, ROOT), ended: { reason: 'holderExited' } }
    ])
  })
})
