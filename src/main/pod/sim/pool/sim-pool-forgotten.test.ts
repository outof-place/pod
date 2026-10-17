// Devices in Pod's own set that the registry does not list (stage 4b): a crash mid-create leaves
// one on disk, and a name taken on disk must not be given again.
import { describe, expect, it } from 'vitest'
import { EMPTY_SIM_POOL_MEMORY, runtimeKey } from './sim-pool-draft'
import { agent, IPHONE, PEER, PoolWorld, ROOT, T0, udid } from './sim-pool.test-support'

const RUNTIME = 'iOS 26.5'

function onDisk(
  world: PoolWorld,
  n: number,
  name: string,
  state: 'shutdown' | 'booted' = 'shutdown'
) {
  world.observed.set(udid(n), { udid: udid(n), name, state, deviceType: IPHONE, runtime: RUNTIME })
  return udid(n)
}

describe('devices of Pod’s set the registry forgot', () => {
  it('deletes a shut-down one through a registry op both runtimes see, then forgets it', () => {
    const world = new PoolWorld()
    const lost = onDisk(world, 77, 'Portivo-Pod-1')
    world.poll()
    // It keeps a lease file, like every device the registry lists, until it is gone.
    expect(world.effectKinds()).toEqual([`writeLeaseFile ${lost}`, `delete ${lost}`])
    expect(world.found(lost)).toMatchObject({ op: { kind: 'delete' }, deviceType: IPHONE })
    world.finish(lost)
    expect(world.registry.devices).toEqual([])
    expect(world.effectKinds()).toEqual([`removeLeaseFile ${lost}`])
  })

  it('leaves a booted one, and any device not named as Pod names its own', () => {
    const world = new PoolWorld()
    onDisk(world, 77, 'Portivo-Pod-1', 'booted')
    onDisk(world, 78, 'Portivo-E2E-iPhone')
    world.poll()
    expect(world.effectKinds()).toEqual([])
    expect(world.registry.devices).toEqual([])
  })

  it('leaves the device an unfinished create is making, whichever runtime runs it', () => {
    const world = new PoolWorld()
    world.lease(agent(42001))
    world.poll()
    const making = world.registry.devices[0]
    expect(making.op?.kind).toBe('create')
    // simctl has made it; the create's outcome has not reached the registry yet.
    onDisk(world, 77, making.name)
    world.poll()
    expect(world.effectKinds().filter((effect) => effect.startsWith('delete'))).toEqual([])
  })

  it('deletes what a runtime that crashed mid-create left on disk, in the same poll', () => {
    const world = new PoolWorld()
    world.registry.devices.push({
      udid: udid(9001),
      name: 'Portivo-Pod-1',
      role: 'pool',
      deviceType: IPHONE,
      runtime: RUNTIME,
      createdAt: T0 - 60_000,
      // Where a create leaves its device (create moves absent to preparing).
      state: 'preparing',
      op: { kind: 'create', by: PEER, since: T0 - 60_000 }
    })
    world.runtimes[runtimeKey(PEER)] = 'exited'
    const left = onDisk(world, 77, 'Portivo-Pod-1')
    world.poll()
    expect(world.registry.devices.map((device) => [device.udid, device.op?.kind])).toEqual([
      [left, 'delete']
    ])
  })

  it('never hands out one whose delete failed, and deletes it again on the next listing', () => {
    const world = new PoolWorld()
    const lost = onDisk(world, 77, 'Portivo-Pod-1')
    world.poll()
    world.finish(lost, { ok: false, message: 'simctl delete exited 1: busy' })
    // Never slimmed: a waiter gets a new device, not this one booted.
    world.lease(agent(42001))
    expect(world.effectKinds()).not.toContain(`boot ${lost}`)
    expect(world.effects.some((effect) => effect.kind === 'create')).toBe(true)
    world.advance(30_000)
    world.poll()
    expect(world.effectKinds()).toContain(`delete ${lost}`)
  })

  it('never names a new device after one on disk', () => {
    const world = new PoolWorld()
    onDisk(world, 77, 'Portivo-Pod-1', 'booted')
    world.lease(agent(42001))
    world.poll()
    const created = world.effects.find((effect) => effect.kind === 'create')
    expect(created && 'name' in created && created.name).toBe('Portivo-Pod-2')
  })
})

describe('an empty list the adapter found empty on disk too', () => {
  it('is believed: a held device deleted outside Pod goes, and its lease hears deviceLost', () => {
    const world = new PoolWorld()
    const holder = agent(42001)
    world.device(1, { state: 'leased' })
    world.addLease(holder, { state: 'active', udid: udid(1) })
    world.poll()
    world.observed.clear()
    world.onDisk = new Set()
    world.advance(5_000)
    world.poll()
    expect(world.registry.devices).toEqual([])
    expect(
      world.registry.tombstones?.map((ended) => [ended.worktreeRoot, ended.ended.reason])
    ).toEqual([[ROOT, 'deviceLost']])
  })

  it('without that, stays the lost contact decision 7 says it is', () => {
    const world = new PoolWorld()
    world.device(1, { state: 'leased' })
    world.addLease(agent(42001), { state: 'active', udid: udid(1) })
    world.poll()
    world.observed.clear()
    world.advance(5_000)
    world.poll()
    expect(world.found(udid(1)).state).toBe('leased')
  })
})

describe('a list that misses a device its folder still holds', () => {
  it('is no evidence the device is gone: a held one keeps its lease', () => {
    const world = new PoolWorld()
    const holder = agent(42001)
    const held = world.device(1, { state: 'leased' })
    world.addLease(holder, { state: 'active', udid: held })
    world.onDisk = new Set([held])
    world.poll()
    // simctl's list drops it once; the disk still has it.
    world.observed.delete(held)
    world.advance(5_000)
    world.poll()
    expect(world.found(held).state).toBe('leased')
    expect(world.leaseOf(holder)?.state).toBe('active')
    expect(world.effectKinds().filter((effect) => effect.startsWith('delete'))).toEqual([])
  })

  it('without the folder either, it is gone as before', () => {
    const world = new PoolWorld()
    const holder = agent(42001)
    const held = world.device(1, { state: 'leased' })
    world.addLease(holder, { state: 'active', udid: held })
    world.onDisk = new Set([held])
    world.poll()
    world.observed.delete(held)
    world.onDisk = new Set()
    world.advance(5_000)
    world.poll()
    expect(world.registry.devices).toEqual([])
  })
})

describe('the lease file of a device that left while no runtime watched', () => {
  it('goes when a restarted runtime forgets the device, though it never wrote that file', () => {
    const world = new PoolWorld()
    const gone = world.device(1, { state: 'shutdown' })
    world.poll()
    // Pod restarts; the device was deleted meanwhile.
    world.memory = structuredClone(EMPTY_SIM_POOL_MEMORY)
    world.observed.delete(gone)
    world.onDisk = new Set()
    world.advance(5_000)
    world.poll()
    expect(world.registry.devices).toEqual([])
    expect(world.effectKinds()).toContain(`removeLeaseFile ${gone}`)
  })
})

describe('booted devices of Pod’s name the registry does not list', () => {
  function strayWorld() {
    const world = new PoolWorld({ cap: 2 })
    const one = onDisk(world, 81, 'Portivo-Pod-1', 'booted')
    const two = onDisk(world, 82, 'Portivo-Pod-2', 'booted')
    world.onDisk = new Set([one, two])
    return { world, one, two }
  }

  it('hold the cap only until one more listing has seen them, then Pod shuts them down', () => {
    const { world, one, two } = strayWorld()
    const waiter = agent(42001)
    world.poll()
    const answer = world.lease(waiter)
    expect(answer.status === 'waiting' && answer.waitingFor).toBe('slot')
    // The waiter is told what holds the slots.
    expect(answer.status === 'waiting' && answer.unlisted).toEqual([
      { udid: one, name: 'Portivo-Pod-1' },
      { udid: two, name: 'Portivo-Pod-2' }
    ])
    // The same listing again (polls between lists carry it): nothing yet.
    world.poll()
    expect(world.effectKinds().filter((effect) => effect.startsWith('shutDown'))).toEqual([])
    world.advance(30_000)
    world.poll()
    expect(
      world
        .effectKinds()
        .filter((effect) => effect.startsWith('shutDown'))
        .sort()
    ).toEqual([`shutDown ${one}`, `shutDown ${two}`])
    // Never adopted (S5): they stay out of the registry.
    expect(world.registry.devices.filter((device) => device.state !== 'shutdown')).toEqual([])
    // Shut down, the next listing deletes them like any forgotten device, and the waiter is served.
    onDisk(world, 81, 'Portivo-Pod-1')
    onDisk(world, 82, 'Portivo-Pod-2')
    world.advance(30_000)
    world.poll()
    expect(
      world
        .effectKinds()
        .filter((effect) => effect.startsWith('delete'))
        .sort()
    ).toEqual([`delete ${one}`, `delete ${two}`])
    expect(world.effects.some((effect) => effect.kind === 'create')).toBe(true)
  })

  it('a day of polls never leaves the waiter stuck behind them (the skeptic’s B)', () => {
    const { world } = strayWorld()
    world.lease(agent(42001))
    let shutDowns = 0
    for (let poll = 0; poll < 1440 && shutDowns === 0; poll += 1) {
      world.advance(60_000)
      world.poll()
      shutDowns += world.effects.filter((effect) => effect.kind === 'shutDown').length
    }
    expect(shutDowns).toBe(2)
  })

  it('leaves one an outside tool is driving, and one a create in flight is making', () => {
    const { world, one, two } = strayWorld()
    world.externalUse = [one]
    world.registry.devices.push({
      udid: udid(9001),
      name: 'Portivo-Pod-2',
      role: 'pool',
      deviceType: IPHONE,
      runtime: RUNTIME,
      createdAt: T0,
      state: 'preparing',
      op: { kind: 'create', by: world.self, since: T0 }
    })
    world.poll()
    world.advance(30_000)
    world.poll()
    expect(world.effectKinds()).not.toContain(`shutDown ${one}`)
    expect(world.effectKinds()).not.toContain(`shutDown ${two}`)
  })
})
