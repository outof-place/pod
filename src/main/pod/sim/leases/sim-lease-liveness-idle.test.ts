import { describe, expect, it } from 'vitest'
import { agent, callerOf, PEER, PoolWorld, ROOT, udid } from '../pool/sim-pool.test-support'

const A = agent(41001)
const B = agent(41002)
const C = agent(41003)
const D = agent(41004)
const IDLE = 30 * 60_000

/** A holds P1 and B holds P2, both booted; P3 is a spare shut-down device unless `spare` is false. */
function heldWorld(options: { cap?: number; spare?: boolean } = {}): PoolWorld {
  const world = new PoolWorld({ cap: options.cap ?? 2 })
  world.device(1)
  world.device(2)
  if (options.spare ?? true) {
    world.device(3)
  }
  world.poll()
  world.lease(A)
  world.lease(B)
  world.finish(udid(1))
  world.finish(udid(2))
  world.lease(A)
  world.lease(B)
  return world
}

function leaseIdOf(world: PoolWorld, holder: typeof A): string {
  return world.leaseOf(holder)?.leaseId ?? 'none'
}

/** Polls every 5 minutes for `ms`; B calls all along and so do `waiting` (only A sits idle). */
function idleFor(world: PoolWorld, ms: number, waiting: (typeof A)[] = []): void {
  for (let passed = 0; passed < ms; passed += 5 * 60_000) {
    world.advance(5 * 60_000)
    world.verb(B)
    for (const holder of waiting) {
      world.waitMine(holder)
    }
    world.poll()
    world.settleOps()
  }
}

describe('holder liveness', () => {
  it('releases an exited holder within one poll and gives its device to the head waiter', () => {
    const world = heldWorld()
    world.lease(C)
    world.liveness[leaseIdOf(world, A)] = 'exited'
    world.advance(2_000)
    world.poll()
    expect(world.leaseOf(A)).toBeUndefined()
    expect(world.effectKinds()).toContain(`release ${udid(1)}`)
    world.finish(udid(1))
    expect(world.leaseOf(C)).toMatchObject({ state: 'reserved', udid: udid(1) })
  })

  it('releases an exited holder whose lease the other runtime serves', () => {
    const world = heldWorld()
    const lease = world.leaseOf(A)
    if (lease) {
      lease.servedBy = PEER
    }
    world.liveness[leaseIdOf(world, A)] = 'exited'
    world.poll()
    expect(world.registry.tombstones?.[0]).toMatchObject({
      key: callerOf(A).key,
      ended: { reason: 'holderExited' }
    })
  })

  it('never releases a holder it cannot verify, however long', () => {
    const world = heldWorld()
    world.liveness[leaseIdOf(world, A)] = 'unverifiable'
    for (let hour = 0; hour < 3; hour += 1) {
      world.advance(60 * 60_000)
      world.poll()
    }
    expect(world.leaseOf(A)).toMatchObject({ state: 'active', udid: udid(1) })
  })

  it('moves the next waiter up when a waiting holder exits', () => {
    const world = heldWorld({ spare: false })
    world.lease(C)
    world.lease(D)
    world.liveness[leaseIdOf(world, C)] = 'exited'
    world.poll()
    expect(world.leaseOf(C)).toBeUndefined()
    expect(world.lease(D)).toMatchObject({ status: 'waiting', position: 1 })
  })

  it('keeps a holder first when its podx call is killed: the call is not the holder', () => {
    const world = heldWorld({ spare: false })
    world.lease(C)
    const first = leaseIdOf(world, C)
    world.openCalls.add(first)
    world.lease(D)
    world.openCalls.clear()
    world.liveness[first] = 'live'
    world.advance(120_000)
    const poll = world.poll()
    expect(poll.trace.filter((move) => move.event === 'holderExited')).toEqual([])
    expect(world.lease(C)).toMatchObject({
      status: 'waiting',
      position: 1,
      lease: { leaseId: first }
    })
  })

  it('never ends a person by liveness', () => {
    const world = new PoolWorld()
    world.device(1, { state: 'ready' })
    world.poll()
    const taken = world.step({
      kind: 'takeoverDevice',
      udid: udid(1),
      person: 'filip',
      worktreeRoot: ROOT
    })
    const lease =
      taken.answer.kind === 'takeover' && taken.answer.answer.ok ? taken.answer.answer.lease : null
    world.liveness[lease?.leaseId ?? ''] = 'exited'
    world.poll()
    expect(world.registry.leases).toMatchObject([{ state: 'takeover', holder: { kind: 'human' } }])
  })
})

describe('idle leases', () => {
  it('leaves an idle lease alone when nobody waits and memory is calm, for hours', () => {
    const world = heldWorld()
    idleFor(world, 3 * 60 * 60_000)
    expect(world.leaseOf(A)).toMatchObject({ state: 'active', udid: udid(1) })
  })

  it('revokes an idle lease for a waiter that nothing else can serve; the old holder hears why', () => {
    const world = heldWorld({ spare: false })
    idleFor(world, IDLE + 60_000)
    world.lease(C)
    expect(world.leaseOf(A)).toBeUndefined()
    world.finish(udid(1))
    expect(world.leaseOf(C)).toMatchObject({ state: 'reserved', udid: udid(1) })
    world.advance(40 * 60_000)
    expect(world.verb(A, 'read')).toEqual({
      allow: false,
      refusal: { code: 'lease_expired', reason: 'idleForWaiter' }
    })
    expect(world.release(A)).toMatchObject({ released: false, ended: { reason: 'idleForWaiter' } })
    world.lease(D)
    expect(world.lease(A)).toMatchObject({ status: 'waiting', position: 2 })
  })

  it('revokes nothing for a waiter whose client still builds or who wants another class', () => {
    const world = heldWorld({ spare: false })
    idleFor(world, IDLE + 60_000)
    world.lease(C, { buildId: 'sb_maps_1' })
    world.lease(D, { wants: { deviceClass: 'ipad' } })
    expect(world.leaseOf(A)?.state).toBe('active')
  })

  it('revokes nothing when a spare device can serve the waiter', () => {
    const world = heldWorld({ cap: 3 })
    idleFor(world, IDLE + 60_000)
    world.lease(C)
    expect(world.leaseOf(A)?.state).toBe('active')
    expect(world.effectKinds()).toContain(`boot ${udid(3)}`)
  })

  it('counts a process with the UDID in its argv (a Maestro run) as use', () => {
    const world = heldWorld({ spare: false })
    world.externalUse = [udid(1)]
    idleFor(world, IDLE + 60_000)
    world.lease(C)
    expect(world.leaseOf(A)?.state).toBe('active')
  })

  it('restarts the idle clock when a takeover is given back', () => {
    const world = heldWorld({ spare: false })
    world.takeover(leaseIdOf(world, A))
    for (let minute = 1; minute <= 40; minute += 1) {
      world.advance(60_000)
      world.step({ kind: 'humanInput', leaseId: leaseIdOf(world, A) })
      world.verb(B)
      if (minute % 5 === 0) {
        world.poll()
      }
    }
    world.step({ kind: 'giveBack', leaseId: leaseIdOf(world, A) })
    world.lease(C)
    idleFor(world, IDLE - 5 * 60_000, [C])
    expect(world.leaseOf(A)?.state).toBe('active')
    idleFor(world, 10 * 60_000, [C])
    expect(world.leaseOf(A)).toBeUndefined()
    expect(world.leaseOf(C)).toMatchObject({ udid: udid(1) })
  })
})

describe('the memory brake', () => {
  it('hands a freed booted device to a waiter at `brake` but boots nothing; the next waiter hears why', () => {
    const world = heldWorld()
    world.lease(C)
    world.capacity.brake = 'brake'
    world.poll()
    world.release(A)
    world.finish(udid(1))
    expect(world.leaseOf(C)).toMatchObject({ state: 'reserved', udid: udid(1) })
    expect(world.lease(D)).toMatchObject({ status: 'waiting', waitingFor: 'brake' })
    expect(world.effectKinds().filter((effect) => effect.startsWith('boot'))).toEqual([])
  })

  it('at `tight` with no waiter ends an idle lease for memory and shuts its device in the same step', () => {
    const world = heldWorld({ spare: false })
    idleFor(world, IDLE + 60_000)
    world.capacity.brake = 'tight'
    world.poll()
    expect(world.registry.tombstones?.at(-1)).toMatchObject({
      key: callerOf(A).key,
      ended: { reason: 'memoryBrake' }
    })
    expect(world.effectKinds()).toContain(`shutDown ${udid(1)}`)
    expect(world.effectKinds()).not.toContain(`release ${udid(1)}`)
    expect(world.leaseOf(B)?.state).toBe('active')
  })

  it('at `tight` with a waiter gives the idle device to it instead', () => {
    const world = heldWorld({ spare: false })
    world.capacity.brake = 'tight'
    world.poll()
    const from = world.traces.length
    world.lease(C)
    // Polls first, so the step that finds A idle reads `tight` fresh.
    for (let passed = 0; passed < IDLE + 60_000; passed += 5 * 60_000) {
      world.advance(5 * 60_000)
      world.poll()
      world.verb(B)
      world.waitMine(C)
      world.settleOps()
    }
    expect(world.registry.tombstones?.at(-1)).toMatchObject({
      key: callerOf(A).key,
      ended: { reason: 'idleForWaiter' }
    })
    expect(world.leaseOf(C)).toMatchObject({ udid: udid(1) })
    const moves = world.traces
      .slice(from)
      .filter((move) => move.id === udid(1))
      .map((move) => move.event)
    expect(moves).toEqual(['release', 'released', 'lease'])
  })

  it('revokes each idle lease once on a flapping brake and boots nothing until calm has held', () => {
    const world = heldWorld({ spare: false })
    for (let passed = 0; passed < IDLE + 60_000; passed += 5 * 60_000) {
      world.advance(5 * 60_000)
      world.poll()
    }
    world.capacity.brake = 'tight'
    world.poll()
    world.finish(udid(1))
    world.finish(udid(2))
    const revoked = world.registry.tombstones?.filter(
      (ended) => ended.ended.reason === 'memoryBrake'
    )
    expect(revoked?.map((ended) => ended.key).sort()).toEqual(
      [callerOf(A).key, callerOf(B).key].sort()
    )
    world.capacity.brake = 'calm'
    world.advance(30_000)
    world.poll()
    world.capacity.brake = 'tight'
    world.advance(5_000)
    world.poll()
    world.capacity.brake = 'calm'
    world.advance(5_000)
    world.poll()
    expect(world.lease(C)).toMatchObject({ status: 'waiting', waitingFor: 'brake' })
    world.advance(60_000)
    world.poll()
    expect(world.effectKinds().filter((effect) => effect.startsWith('boot'))).toEqual([])
    world.advance(61_000)
    world.poll()
    expect(world.effectKinds().filter((effect) => effect.startsWith('boot'))).toHaveLength(1)
  })

  it('leaves a takeover alone at `emergency`, however long its agent has been quiet', () => {
    const world = heldWorld({ spare: false })
    world.takeover(leaseIdOf(world, A))
    const from = world.traces.length
    world.capacity.brake = 'emergency'
    for (let minute = 1; minute <= IDLE / 60_000 + 5; minute += 1) {
      world.advance(60_000)
      world.step({ kind: 'humanInput', leaseId: leaseIdOf(world, A) })
      world.poll()
    }
    expect(world.leaseOf(A)?.state).toBe('takeover')
    expect(world.traces.slice(from).filter((move) => move.id === udid(1))).toEqual([])
  })
})

describe('claude-acc going quiet is not calm', () => {
  for (const [name, setup] of [
    ['a reading 45 s old', (world: PoolWorld) => (world.capacity.measuredAt = world.wall - 45_000)],
    [
      'a reading without the simulators block',
      (world: PoolWorld) => {
        world.capacity.cap = 'unknown'
        world.capacity.outsideBooted = 'unknown'
      }
    ],
    ['a reading without a brake stage', (world: PoolWorld) => (world.capacity.brake = 'unknown')]
  ] as const) {
    it(`boots nothing on ${name}, but still hands out a booted free device`, () => {
      const world = new PoolWorld()
      world.device(1, { state: 'ready' })
      world.device(2)
      setup(world)
      world.poll()
      expect(world.lease(A)).toMatchObject({ status: 'ready', device: { udid: udid(1) } })
      expect(world.lease(B)).toMatchObject({ status: 'waiting', waitingFor: 'brake' })
      expect(world.effectKinds().filter((effect) => effect.startsWith('boot'))).toEqual([])
    })
  }

  it("applies Pod's own cap when claude-acc says 0 (no cap there)", () => {
    const world = new PoolWorld({ cap: 0, config: { podCap: 1 } })
    world.device(1)
    world.device(2)
    world.poll()
    world.lease(A)
    expect(world.effectKinds()).toContain(`boot ${udid(1)}`)
    expect(world.lease(B)).toMatchObject({ status: 'waiting', waitingFor: 'slot' })
  })
})
