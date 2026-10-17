import { describe, expect, it } from 'vitest'
import type { SimHolder } from '../../../../shared/pod-sim/sim-holder'
import type { SimDeviceOp } from './sim-pool-config'
import { agent, IPHONE, PoolWorld } from './sim-pool.test-support'

const A = agent(46001)
const B = agent(46002)
const INVALID = 'Invalid runtime: com.apple.CoreSimulator.SimRuntime.iOS-26-5'

/**
 * A poll every 5 s for `ms` with `callers` calling all along, and simctl answering every op at
 * once, every `failing` op with an error.
 */
function failFor(
  world: PoolWorld,
  failing: SimDeviceOp | null,
  ms: number,
  callers: readonly SimHolder[] = [A]
): void {
  for (let passed = 0; passed < ms; passed += 5_000) {
    world.advance(5_000)
    for (const holder of callers) {
      world.waitMine(holder)
    }
    world.poll()
    for (let round = 0; round < 50; round += 1) {
      const busy = world.registry.devices.find((device) => device.op)
      if (!busy?.op) {
        break
      }
      world.finish(
        busy.udid,
        busy.op.kind === failing ? { ok: false, message: INVALID } : { ok: true }
      )
    }
  }
}

function count(world: PoolWorld, ...events: string[]): number {
  return world.traces.filter((move) => move.machine === 'device' && events.includes(move.event))
    .length
}

function emptyPool(): PoolWorld {
  const world = new PoolWorld({ cap: 2 })
  world.poll()
  world.lease(A)
  return world
}

describe('a device the pool cannot make or start', () => {
  it('stops creating after a few failed creates and tells the waiter why', () => {
    const world = emptyPool()
    failFor(world, 'create', 30 * 60_000)
    expect(count(world, 'create', 'clone')).toBeLessThanOrEqual(8)
    expect(world.lease(A)).toMatchObject({
      status: 'waiting',
      waitingFor: 'device',
      stalled: { reason: 'failing', failure: INVALID }
    })
  })

  it('stops making devices whose slimming fails', () => {
    const world = emptyPool()
    failFor(world, 'prepare', 30 * 60_000)
    expect(count(world, 'create', 'clone')).toBeLessThanOrEqual(8)
    expect(world.lease(A)).toMatchObject({
      status: 'waiting',
      stalled: { reason: 'failing', failure: INVALID }
    })
  })

  it('stops making and booting devices whose boot fails', () => {
    const world = emptyPool()
    failFor(world, 'boot', 30 * 60_000)
    expect(count(world, 'create', 'clone')).toBeLessThanOrEqual(8)
    expect(count(world, 'boot')).toBeLessThanOrEqual(12)
    expect(world.lease(A)).toMatchObject({
      status: 'waiting',
      stalled: { reason: 'failing', failure: INVALID }
    })
  })

  it('tries again later, longer each time, and says when', () => {
    const world = emptyPool()
    failFor(world, 'create', 60_000)
    const first = world.lease(A)
    const retryAt = first.status === 'waiting' ? first.stalled : undefined
    expect(retryAt).toMatchObject({ reason: 'failing', failures: 3 })
    const at = retryAt?.reason === 'failing' ? (retryAt.retryAt ?? 0) : 0
    expect(at).toBeGreaterThan(world.wall)
    expect(at - world.wall).toBeLessThanOrEqual(60_000)
    expect(count(world, 'create')).toBe(3)
    failFor(world, 'create', 70_000)
    expect(count(world, 'create')).toBe(4)
    const second = world.lease(A)
    const later = second.status === 'waiting' ? second.stalled : undefined
    expect(later).toMatchObject({ failures: 4 })
    const next = later?.reason === 'failing' ? (later.retryAt ?? 0) : 0
    // One minute after the third failure in a row, two after the fourth.
    expect(next - at).toBe(120_000)
  })

  it('makes again at once when the config names another runtime', () => {
    const world = emptyPool()
    failFor(world, 'create', 60_000)
    const before = count(world, 'create')
    world.config = {
      ...world.config,
      deviceTypes: { iphone: { deviceType: IPHONE, runtime: 'iOS 26.4' } }
    }
    world.lease(A)
    expect(count(world, 'create')).toBe(before + 1)
    expect(world.effects).toContainEqual(
      expect.objectContaining({ kind: 'create', runtime: 'iOS 26.4' })
    )
  })

  it('forgets the failures once a device of the kind boots', () => {
    const world = emptyPool()
    failFor(world, 'boot', 20_000)
    const failing = world.lease(A)
    expect(failing).toMatchObject({ status: 'waiting', stalled: { reason: 'failing' } })
    failFor(world, null, 5 * 60_000)
    expect(world.lease(A)).toMatchObject({ status: 'ready' })
    expect(world.registry.makeFailures ?? []).toEqual([])
    world.lease(B)
    expect(world.lease(B)).not.toHaveProperty('stalled')
  })
})
