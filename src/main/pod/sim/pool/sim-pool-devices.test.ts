import { describe, expect, it } from 'vitest'
import { agent, callerOf, PEER, PoolWorld, udid } from './sim-pool.test-support'

const A = agent(41001)
const B = agent(41002)
const C = agent(41003)
const D = agent(41004)
const E = agent(41005)
const OLD = { pid: 60001, startedAt: 1760500000 }

function bootKinds(world: PoolWorld): string[] {
  return world.effectKinds().filter((effect) => /^(boot|prepare|reset)/.test(effect))
}

describe('the cap counts everything that may be booted', () => {
  it('waits for a slot while a device outside Pod is booted, then slims the clone and serves', () => {
    const world = new PoolWorld({ cap: 2, outside: 1 })
    world.device(1, { state: 'leased' })
    world.addLease(A, { state: 'active', udid: udid(1) })
    world.device(2, { state: 'preparing' })
    world.poll()
    const waiting = world.lease(B)
    expect(waiting).toMatchObject({ status: 'waiting', waitingFor: 'slot' })
    expect(waiting.status === 'waiting' && waiting.holders.map((holder) => holder.id)).toEqual([
      A.id
    ])
    expect(bootKinds(world)).toEqual([])
    // No second clone either: the one being made is for B.
    expect(world.effectKinds().filter((effect) => /^(clone|create)/.test(effect))).toEqual([])
    world.capacity.outsideBooted = 0
    world.advance(2_000)
    world.poll()
    expect(bootKinds(world)).toEqual([`prepare ${udid(2)}`])
    world.finish(udid(2))
    expect(bootKinds(world)).toEqual([`boot ${udid(2)}`])
    world.finish(udid(2))
    expect(world.lease(B)).toMatchObject({ status: 'ready', device: { udid: udid(2) } })
  })

  it("counts the other runtime's boot in flight", () => {
    const world = new PoolWorld({ cap: 2 })
    world.device(1)
    world.device(2)
    world.device(3, { state: 'booting' })
    world.found(udid(3)).op = { kind: 'boot', by: PEER, since: world.wall }
    world.runtimes[`${PEER.pid}:${PEER.startedAt}`] = 'live'
    world.poll()
    world.lease(A)
    expect(bootKinds(world)).toEqual([`boot ${udid(1)}`])
    expect(world.lease(B)).toMatchObject({ status: 'waiting', waitingFor: 'slot' })
  })

  it('fails a device whose op passed its deadline, though its runtime lives, and frees the slot', () => {
    const world = new PoolWorld({ cap: 2 })
    world.device(1, { state: 'leased' })
    world.addLease(A, { state: 'active', udid: udid(1) })
    world.device(2)
    world.device(3, { state: 'booting' })
    const op = { kind: 'boot' as const, by: PEER, since: world.wall }
    world.found(udid(3)).op = op
    world.runtimes[`${PEER.pid}:${PEER.startedAt}`] = 'live'
    world.poll()
    world.lease(B)
    expect(bootKinds(world)).toEqual([])
    world.advance(25 * 60_000)
    world.observed.set(udid(3), { udid: udid(3), name: 'Portivo-Pod-3', state: 'shutdown' })
    world.waitMine(B)
    expect(world.found(udid(3))).toMatchObject({ state: 'failed', failure: { op: 'boot' } })
    world.advance(2_000)
    world.poll()
    expect(world.found(udid(3))).toMatchObject({ state: 'shutdown', failure: { op: 'boot' } })
    expect(bootKinds(world)).toEqual([`boot ${udid(2)}`])
    // The other runtime's boot answering late changes nothing.
    world.step({ kind: 'opFinished', udid: udid(3), op, outcome: { ok: true } })
    expect(world.found(udid(3)).state).toBe('shutdown')
  })
})

describe('a runtime restarts 90 s after a crash', () => {
  function crashedWorld(cap: number): PoolWorld {
    const world = new PoolWorld({ cap })
    world.self = OLD
    for (const n of [1, 3, 4, 5]) {
      world.device(n, { state: 'leased' })
    }
    world.device(2, { state: 'ready' })
    world.addLease(A, { state: 'active', udid: udid(1) })
    world.addLease(B, { state: 'reserved', udid: udid(2), reservedUntil: world.wall - 30_000 })
    world.addLease(C, {
      state: 'takeover',
      udid: udid(3),
      takeover: { since: world.wall - 600_000, lastInput: world.wall - 200_000 }
    })
    world.addLease(D, { state: 'active', udid: udid(4) })
    world.addLease(E, { state: 'active', udid: udid(5) })
    world.registry.updatedAt = world.wall
    world.observed.delete(udid(4))
    world.observed.set(udid(5), { udid: udid(5), name: 'Portivo-Pod-5', state: 'shutdown' })
    world.observed.set(udid(9), { udid: udid(9), name: 'Portivo-Pod-9', state: 'booted' })
    world.self = { pid: 70110, startedAt: 1760599900 }
    world.runtimes[`${OLD.pid}:${OLD.startedAt}`] = 'exited'
    world.advance(90_000)
    return world
  }

  it('writes every lease file before anything else and adopts what the dead runtime served', () => {
    const world = crashedWorld(5)
    world.poll()
    const kinds = world.effects.map((effect) => effect.kind)
    const files = kinds.filter((kind) => kind === 'writeLeaseFile').length
    expect(files).toBe(4)
    expect(kinds.slice(0, files)).toEqual(Array(files).fill('writeLeaseFile'))
    expect(world.leaseOf(A)).toMatchObject({ state: 'active', servedBy: world.self })
  })

  it('gives a reservation a fresh 60 s window instead of sending it back', () => {
    const world = crashedWorld(5)
    world.poll()
    expect(world.leaseOf(B)).toMatchObject({
      state: 'reserved',
      reservedUntil: world.wall + 60_000
    })
    world.advance(59_000)
    world.poll()
    expect(world.leaseOf(B)?.state).toBe('reserved')
  })

  it('gives a takeover back after 120 s this runtime watched, then releases its exited agent', () => {
    const world = crashedWorld(5)
    world.liveness[world.leaseOf(C)?.leaseId ?? ''] = 'exited'
    world.poll()
    expect(world.leaseOf(C)?.state).toBe('takeover')
    world.advance(121_000)
    world.poll()
    expect(world.leaseOf(C)).toBeUndefined()
    expect(world.registry.tombstones?.find((ended) => ended.key === callerOf(C).key)).toMatchObject(
      {
        ended: { reason: 'holderExited' }
      }
    )
  })

  it('ends the lease of a device deleted outside Pod with deviceLost', () => {
    const world = crashedWorld(5)
    world.poll()
    expect(world.found.bind(world, udid(4))).toThrow()
    expect(world.verb(D)).toEqual({
      allow: false,
      refusal: { code: 'lease_expired', reason: 'deviceLost' }
    })
  })

  it('brings a device shut down outside Pod back on the same UDID, its lease kept', () => {
    const world = crashedWorld(5)
    world.poll()
    expect(
      world.last?.trace.filter((move) => move.id === udid(5)).map((move) => move.event)
    ).toEqual(expect.arrayContaining(['lost', 'recover']))
    expect(world.leaseOf(E)?.state).toBe('active')
    expect(bootKinds(world)).toContain(`boot ${udid(5)}`)
  })

  it('never adopts a booted device the registry does not list, but counts it', () => {
    const world = crashedWorld(4)
    world.poll()
    expect(world.registry.devices.map((device) => device.name)).not.toContain('Portivo-Pod-9')
    expect(bootKinds(world)).toEqual([])
    const refusal = world.verb(E)
    expect(refusal).toMatchObject({ allow: false, refusal: { code: 'device_down', state: 'lost' } })
  })
})

describe('losing contact with CoreSimulator is not losing devices', () => {
  it('changes nothing through a timeout, an empty list and the devices coming back', () => {
    const world = new PoolWorld({ cap: 3 })
    world.device(1, { state: 'leased' })
    world.device(2, { state: 'leased' })
    world.device(3)
    world.addLease(A, { state: 'active', udid: udid(1) })
    world.addLease(B, { state: 'active', udid: udid(2) })
    world.poll()
    const leases = JSON.stringify(world.registry.leases)
    world.lease(C)
    world.verdict = 'unknown'
    world.advance(30_000)
    world.poll()
    const listed = new Map(world.observed)
    world.verdict = 'ok'
    world.observed.clear()
    world.advance(5_000)
    world.poll()
    const quiet = world.effects.filter((effect) => effect.kind !== 'writeLeaseFile')
    world.observed = listed
    world.advance(5_000)
    world.poll()
    expect(quiet).toEqual([])
    expect(
      JSON.stringify(world.registry.leases.filter((lease) => lease.key !== callerOf(C).key))
    ).toBe(leases)
    expect(world.found(udid(1)).state).toBe('leased')
  })
})

describe('devices nobody holds', () => {
  it('hands a device released within the warm window to the next lease without a boot', () => {
    const world = new PoolWorld()
    world.device(1, { state: 'leased' })
    world.addLease(A, { state: 'active', udid: udid(1) })
    world.poll()
    world.release(A)
    world.finish(udid(1))
    world.advance(9 * 60_000)
    world.poll()
    expect(world.lease(B)).toMatchObject({ status: 'ready', device: { udid: udid(1) } })
    expect(bootKinds(world)).toEqual([])
  })

  it('shuts a device down when the warm window passes with nothing leased', () => {
    const world = new PoolWorld()
    world.device(1, { state: 'leased' })
    world.addLease(A, { state: 'active', udid: udid(1) })
    world.poll()
    world.release(A)
    world.finish(udid(1))
    world.advance(10 * 60_000)
    expect(world.last?.wakeAt).toBe(world.mono)
    world.poll()
    expect(world.effectKinds()).toEqual([`shutDown ${udid(1)}`])
  })

  it('boots a golden device only to prepare it, and never hands it out', () => {
    const world = new PoolWorld()
    world.device(1, { role: 'golden', state: 'preparing' })
    world.device(2, { role: 'golden' })
    world.observed.set(udid(2), { udid: udid(2), name: 'Portivo-Pod-Golden-2', state: 'booted' })
    world.poll()
    expect(world.effectKinds()).toEqual(
      expect.arrayContaining([`prepare ${udid(1)}`, `shutDown ${udid(2)}`])
    )
    world.finish(udid(1))
    world.finish(udid(2))
    world.lease(A, { wants: { deviceClass: 'iphone', deviceType: 'iPhone 16 Pro' } })
    expect(bootKinds(world)).toEqual([])
    expect(world.leaseOf(A)?.udid).toBeUndefined()
  })
})

describe('making devices', () => {
  it('clones the golden device when no device of the class is free, then slims and boots it', () => {
    const world = new PoolWorld()
    world.device(7, { role: 'golden' })
    world.device(1, { state: 'leased' })
    world.addLease(A, { state: 'active', udid: udid(1) })
    world.poll()
    world.lease(B)
    const clone = world.effects.find((effect) => effect.kind === 'clone')
    expect(clone).toMatchObject({ source: udid(7), name: 'Portivo-Pod-2' })
    const provisional = clone && 'udid' in clone ? clone.udid : ''
    expect(world.found(provisional)).toMatchObject({ state: 'cloning', clonedFrom: udid(7) })
    world.finish(provisional)
    const made = world.named('Portivo-Pod-2')
    expect(made?.udid).not.toBe(provisional)
    expect(bootKinds(world)).toEqual([`prepare ${made?.udid}`])
    world.finish(made?.udid ?? '')
    world.finish(made?.udid ?? '')
    expect(world.lease(B)).toMatchObject({ status: 'ready', device: { name: 'Portivo-Pod-2' } })
  })

  it('creates a fresh device when there is no golden one, and stops at the per-class limit', () => {
    const world = new PoolWorld({ cap: 9, config: { maxDevicesPerClass: 2 } })
    world.device(1, { state: 'leased' })
    world.addLease(A, { state: 'active', udid: udid(1) })
    world.poll()
    world.lease(B)
    expect(world.effects.find((effect) => effect.kind === 'create')).toMatchObject({
      name: 'Portivo-Pod-2',
      deviceType: 'iPhone 16 Pro'
    })
    world.lease(C)
    expect(world.effects.filter((effect) => effect.kind === 'create')).toEqual([])
  })

  it("slims an empty pool's first device as soon as it exists, not at simctl's next list", () => {
    const world = new PoolWorld()
    world.poll()
    world.advance(1_000)
    world.lease(A)
    const create = world.effects.find((effect) => effect.kind === 'create')
    world.finish(create && 'udid' in create ? create.udid : '')
    const made = world.named('Portivo-Pod-1')
    expect(bootKinds(world)).toEqual([`prepare ${made?.udid}`])
    world.finish(made?.udid ?? '')
    expect(bootKinds(world)).toEqual([`boot ${made?.udid}`])
  })
})
