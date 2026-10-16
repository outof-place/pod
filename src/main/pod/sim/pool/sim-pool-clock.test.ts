import { describe, expect, it } from 'vitest'
import { EMPTY_SIM_POOL_MEMORY } from './sim-pool-draft'
import { agent, callerOf, PEER, PoolWorld, udid } from './sim-pool.test-support'

const A = agent(41001)
const B = agent(41002)
const C = agent(41003)
const D = agent(41004)
const HOUR = 60 * 60_000

/** A holds P1 (cap 1, P2 spare and shut down); B and C wait for a slot. */
function queuedWorld(): PoolWorld {
  const world = new PoolWorld({ cap: 1 })
  world.device(1, { state: 'leased' })
  world.device(2)
  world.addLease(A, { state: 'active', udid: udid(1) })
  world.poll()
  world.lease(B)
  world.advance(1_000)
  world.lease(C)
  return world
}

function sleepFor(world: PoolWorld, ms: number): void {
  world.wall += ms
  world.mono += 1
  world.capacity.measuredAt = null
}

describe('time no runtime watched', () => {
  it('abandons no waiter over an 8 hour sleep', () => {
    const world = queuedWorld()
    sleepFor(world, 8 * HOUR)
    world.poll()
    expect(world.leaseOf(B)?.state).toBe('waiting')
    expect(world.leaseOf(C)?.state).toBe('waiting')
  })

  it('gives a reservation a fresh window after a sleep', () => {
    const world = queuedWorld()
    world.release(A)
    world.finish(udid(1))
    expect(world.leaseOf(B)?.state).toBe('reserved')
    world.advance(50_000)
    world.poll()
    sleepFor(world, 8 * HOUR)
    world.poll()
    expect(world.leaseOf(B)).toMatchObject({
      state: 'reserved',
      reservedUntil: world.wall + 60_000
    })
    world.advance(30_000)
    world.poll()
    expect(world.leaseOf(B)?.state).toBe('reserved')
  })

  it('holds a reservation no longer than 60 s when the wall clock steps back an hour', () => {
    const world = queuedWorld()
    world.release(A)
    world.finish(udid(1))
    world.wall -= HOUR
    world.capacity.measuredAt = null
    world.advance(30_000)
    world.poll()
    world.advance(61_000)
    world.poll()
    expect(world.leaseOf(C)).toMatchObject({ state: 'reserved', udid: udid(1) })
  })

  it('keeps the queue in order and no idle time negative after the wall clock steps back', () => {
    const world = queuedWorld()
    world.wall -= HOUR
    world.capacity.measuredAt = null
    world.advance(1_000)
    world.lease(D)
    expect(world.lease(B)).toMatchObject({ status: 'waiting', position: 1 })
    expect(world.lease(C)).toMatchObject({ status: 'waiting', position: 2 })
    expect(world.lease(D)).toMatchObject({ status: 'waiting', position: 3 })
    for (const lease of world.registry.leases) {
      expect(world.wall - lease.lastActivity, lease.key).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('an ended lease is remembered', () => {
  function revokedWorld(): PoolWorld {
    const world = queuedWorld()
    world.addLease(D, { state: 'waiting', queue: { position: 9, since: 1, waitingFor: 'slot' } })
    world.step({ kind: 'worktreeRemoved', worktreeRoot: '/nowhere' })
    // A's device lost outside Pod: its lease ends deviceLost.
    world.observed.delete(udid(1))
    world.advance(2_000)
    world.poll()
    return world
  }

  it('tells the old holder why, from the other runtime and after a restart', () => {
    const world = revokedWorld()
    world.self = PEER
    world.memory = structuredClone(EMPTY_SIM_POOL_MEMORY)
    expect(world.verb(A, 'read')).toEqual({
      allow: false,
      refusal: { code: 'lease_expired', reason: 'deviceLost' }
    })
  })

  it('forgets it after 24 hours watched, or as soon as the holder leases again', () => {
    const world = revokedWorld()
    world.lease(A)
    expect(world.registry.tombstones?.some((ended) => ended.key === world.leaseOf(A)?.key)).toBe(
      false
    )
    world.release(A)
    const ofA = () => world.registry.tombstones?.filter((ended) => ended.key === callerOf(A).key)
    world.advance(24 * HOUR - 1_000)
    world.poll()
    expect(ofA()).toHaveLength(1)
    world.advance(2_000)
    world.poll()
    expect(ofA()).toEqual([])
    expect(world.verb(A)).toMatchObject({ allow: false, refusal: { code: 'not_leased' } })
  })
})
