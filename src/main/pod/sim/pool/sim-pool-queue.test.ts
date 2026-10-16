import { describe, expect, it } from 'vitest'
import { agent, callerOf, IPHONE, PEER, PoolWorld, ROOT, udid } from './sim-pool.test-support'

const A = agent(41001)
const B = agent(41002)
const C = agent(41003)
const D = agent(41004)
const E = agent(41005)

function bootedWorld(): PoolWorld {
  const world = new PoolWorld({ cap: 2 })
  world.device(1)
  world.device(2)
  world.device(3)
  world.poll()
  return world
}

/** A and B hold P1 and P2 (booted, leased); C waits for a slot. */
function fullWorld(): PoolWorld {
  const world = bootedWorld()
  world.lease(A)
  world.lease(B)
  world.finish(udid(1))
  world.finish(udid(2))
  world.lease(A)
  world.lease(B)
  return world
}

describe('three requesters on a cap of 2', () => {
  it('boots a device for each of the first two and keeps the third waiting for a slot', () => {
    const world = bootedWorld()
    const first = world.lease(A)
    expect(world.effectKinds()).toContain(`boot ${udid(1)}`)
    expect(first).toMatchObject({ status: 'waiting', waitingFor: 'device' })
    world.lease(B)
    expect(world.effectKinds()).toContain(`boot ${udid(2)}`)
    const third = world.lease(C)
    expect(world.effectKinds().filter((effect) => effect.startsWith('boot'))).toEqual([])
    expect(third).toMatchObject({ status: 'waiting', position: 1, waitingFor: 'slot' })
    expect(third.status === 'waiting' && third.holders.map((holder) => holder.id)).toEqual([
      A.id,
      B.id
    ])
  })

  it('hands each of the first two its booted device once it is ready', () => {
    const world = fullWorld()
    expect(world.lease(A)).toMatchObject({ status: 'ready', device: { udid: udid(1) } })
    expect(world.lease(B)).toMatchObject({ status: 'ready', device: { udid: udid(2) } })
  })

  it('gives the third the first device freed, without a boot, ahead of later callers', () => {
    const world = fullWorld()
    world.lease(C)
    world.advance(10)
    // D asks 10 ms later and its worktree last used P1: neither moves it ahead of C.
    world.lease(D, { worktreeRoot: '/Users/dev/portivo-wt/other' })
    world.found(udid(1)).affinity = '/Users/dev/portivo-wt/other'
    world.release(A)
    world.finish(udid(1))
    expect(world.effectKinds().filter((effect) => effect.startsWith('boot'))).toEqual([])
    expect(world.lease(C)).toMatchObject({ status: 'ready', device: { udid: udid(1) } })
    const later = world.lease(D, { worktreeRoot: '/Users/dev/portivo-wt/other' })
    expect(later).toMatchObject({ status: 'waiting', position: 1 })
  })

  it('answers an open lease --wait the moment the freed device is ready', () => {
    const world = fullWorld()
    world.lease(C)
    const leaseId = world.leaseOf(C)?.leaseId ?? ''
    world.openCalls.add(leaseId)
    world.release(A)
    world.finish(udid(1))
    expect(world.leaseOf(C)).toMatchObject({ state: 'active', udid: udid(1) })
    expect(world.effectKinds()).toContain(`notifyWaiter ${leaseId}`)
  })
})

describe('a reservation', () => {
  it('passes to the next waiter after 60 s unclaimed, and the late waiter rejoins at the back', () => {
    const world = fullWorld()
    world.lease(C)
    world.lease(D)
    world.lease(E)
    world.release(A)
    world.finish(udid(1))
    expect(world.leaseOf(C)).toMatchObject({ state: 'reserved', udid: udid(1) })
    world.advance(59_000)
    world.poll()
    expect(world.leaseOf(C)?.state).toBe('reserved')
    world.advance(2_000)
    world.poll()
    expect(world.leaseOf(D)).toMatchObject({ state: 'reserved', udid: udid(1) })
    expect(world.leaseOf(C)?.state).toBe('waiting')
    // Not not_leased: C is told it waits, and where.
    expect(world.verb(C)).toEqual({
      allow: false,
      refusal: { code: 'lease_waiting', position: 2 }
    })
  })

  it('counts its 60 s from when the device is ready, not from when it was picked', () => {
    const world = new PoolWorld({ cap: 1 })
    world.device(1)
    world.device(2)
    world.poll()
    world.lease(A)
    world.lease(B)
    world.advance(50_000)
    world.finish(udid(1))
    world.advance(55_000)
    world.poll()
    expect(world.leaseOf(A)).toMatchObject({ state: 'reserved', udid: udid(1) })
    world.advance(6_000)
    world.poll()
    expect(world.leaseOf(B)).toMatchObject({ state: 'reserved', udid: udid(1) })
    expect(world.leaseOf(A)?.state).toBe('waiting')
  })

  it('keeps the runtime that holds the waiter call as servedBy, whichever runtime grants', () => {
    const world = fullWorld()
    world.self = PEER
    world.lease(C)
    world.self = { pid: 70110, startedAt: 1760599900 }
    world.release(A)
    world.finish(udid(1))
    expect(world.leaseOf(C)).toMatchObject({ state: 'reserved', servedBy: PEER })
  })
})

describe('the queue place belongs to the holder', () => {
  it('gives two calls of one holder one lease, one id and one place', () => {
    const world = fullWorld()
    world.lease(C)
    const first = world.leaseOf(C)
    world.lease(C)
    expect(world.registry.leases.filter((lease) => lease.key === callerOf(C).key)).toHaveLength(1)
    expect(world.leaseOf(C)).toMatchObject({
      leaseId: first?.leaseId,
      queue: { since: first?.queue?.since }
    })
  })

  it('puts a holder asking for a second device behind holders that hold none', () => {
    const world = fullWorld()
    world.lease(A, { worktreeRoot: '/Users/dev/portivo-wt/second' })
    world.advance(1_000)
    const late = world.lease(C)
    expect(late).toMatchObject({ status: 'waiting', position: 1 })
    expect(world.lease(A, { worktreeRoot: '/Users/dev/portivo-wt/second' })).toMatchObject({
      status: 'waiting',
      position: 2
    })
  })
})

describe('a waiter that cannot use a device yet does not block the queue', () => {
  it('serves the iPhone waiter behind an iPad waiter the pool cannot serve', () => {
    const world = fullWorld()
    const ipad = world.lease(C, { wants: { deviceClass: 'ipad' } })
    expect(ipad).toMatchObject({ status: 'waiting', position: 1, waitingFor: 'device' })
    world.lease(D)
    world.release(A)
    world.finish(udid(1))
    expect(world.leaseOf(D)).toMatchObject({ state: 'reserved', udid: udid(1) })
    expect(world.lease(C, { wants: { deviceClass: 'ipad' } })).toMatchObject({
      status: 'waiting',
      position: 1,
      waitingFor: 'device'
    })
  })

  it('keeps a waiter whose dev client still builds in its place without serving it', () => {
    const world = fullWorld()
    world.lease(C, { buildId: 'sb_maps_1' })
    world.lease(D)
    world.release(A)
    world.finish(udid(1))
    expect(world.leaseOf(D)?.state).toBe('reserved')
    expect(world.lease(C, { buildId: 'sb_maps_1' })).toMatchObject({
      status: 'waiting',
      waitingFor: 'build',
      position: 1
    })
    world.step({ kind: 'buildFinished', buildId: 'sb_maps_1', ok: true })
    world.release(B)
    world.finish(udid(2))
    expect(world.leaseOf(C)).toMatchObject({ state: 'reserved', udid: udid(2) })
  })

  it('ends the lease of a waiter whose build failed, naming the build', () => {
    const world = fullWorld()
    world.lease(C, { buildId: 'sb_maps_1' })
    world.step({ kind: 'buildFinished', buildId: 'sb_maps_1', ok: false })
    expect(world.verb(C)).toEqual({
      allow: false,
      refusal: { code: 'build_failed', buildId: 'sb_maps_1' }
    })
  })

  it('lets affinity pick which free device the head waiter gets', () => {
    const world = new PoolWorld({ cap: 2 })
    world.device(1, { state: 'ready' })
    world.device(2, { state: 'ready', affinity: ROOT })
    world.poll()
    expect(world.lease(A)).toMatchObject({ status: 'ready', device: { udid: udid(2) } })
    expect(world.found(udid(2)).deviceType).toBe(IPHONE)
  })
})
