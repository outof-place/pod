import { describe, expect, it } from 'vitest'
import { agent, callerOf, PoolWorld, ROOT, SELF, udid } from '../pool/sim-pool.test-support'

const A = agent(41001)
const B = agent(41002)
const C = agent(41003)
const MAPS = { id: 'maps', bundleId: 'space.portivo.maps' }

/** A holds P1, booted; P2 is a spare shut-down device. */
function heldWorld(): PoolWorld {
  const world = new PoolWorld({ cap: 2 })
  world.device(1, { state: 'leased' })
  world.addLease(A, { state: 'active', udid: udid(1) })
  world.device(2)
  world.poll()
  return world
}

function leaseIdOf(world: PoolWorld, holder: typeof A): string {
  return world.leaseOf(holder)?.leaseId ?? 'none'
}

describe('Filip takes a device over', () => {
  it("holds the agent's input, keeps its reads, and answers its wait at give-back", () => {
    const world = heldWorld()
    const id = leaseIdOf(world, A)
    expect(world.takeover(id)).toMatchObject({ ok: true })
    expect(world.verb(A, 'input')).toEqual({ allow: false, refusal: { code: 'held_by_human' } })
    expect(world.verb(A, 'read')).toMatchObject({ allow: true, udid: udid(1) })
    expect(world.waitMine(A)).toMatchObject({ status: 'heldByHuman' })
    world.openCalls.add(id)
    world.advance(30_000)
    world.step({ kind: 'giveBack', leaseId: id })
    expect(world.effectKinds()).toContain(`notifyWaiter ${id}`)
    expect(world.verb(A, 'input')).toMatchObject({ allow: true })
  })

  it('names the serving runtime in the lease file while Filip drives, not the agent', () => {
    const world = heldWorld()
    world.takeover(leaseIdOf(world, A))
    expect(world.effects).toContainEqual({
      kind: 'writeLeaseFile',
      udid: udid(1),
      file: { owner: SELF, holder: A.id }
    })
  })

  it("fills claude-acc's lease file with the holder's session and the lease's app", () => {
    const world = new PoolWorld()
    world.device(1, { state: 'ready' })
    world.poll()
    const holder = { ...agent(41007), sessionId: '5d1c9a2e' }
    world.lease(holder, { app: MAPS })
    const owner = { pid: holder.pid, startedAt: holder.startedAt }
    const file = { holder: holder.id, session: '5d1c9a2e', app: 'maps' }
    expect(world.effects).toContainEqual({
      kind: 'writeLeaseFile',
      udid: udid(1),
      file: { owner, ...file }
    })
    world.takeover(world.leaseOf(holder)?.leaseId ?? '')
    expect(world.effects).toContainEqual({
      kind: 'writeLeaseFile',
      udid: udid(1),
      file: { owner: SELF, ...file }
    })
  })

  it('outlives an exited agent until 120 s after the last input, then releases it', () => {
    const world = heldWorld()
    const id = leaseIdOf(world, A)
    world.takeover(id)
    world.liveness[id] = 'exited'
    world.advance(60_000)
    world.step({ kind: 'humanInput', leaseId: id })
    world.poll()
    expect(world.leaseOf(A)?.state).toBe('takeover')
    world.advance(119_000)
    world.poll()
    expect(world.leaseOf(A)?.state).toBe('takeover')
    world.advance(2_000)
    world.poll()
    expect(world.leaseOf(A)).toBeUndefined()
    expect(world.release(A)).toMatchObject({ released: false, ended: { reason: 'holderExited' } })
  })

  it('gives back on its own even with no tab attached, and revokes nothing at `tight`', () => {
    const world = heldWorld()
    const id = leaseIdOf(world, A)
    world.takeover(id)
    world.capacity.brake = 'tight'
    for (let minute = 0; minute < 40; minute += 1) {
      world.advance(60_000)
      world.step({ kind: 'humanInput', leaseId: id })
      world.poll()
    }
    expect(world.leaseOf(A)?.state).toBe('takeover')
    // The tab is gone: no input, no give-back command. 120 s later the lease is the agent's again.
    world.advance(121_000)
    world.poll()
    expect(world.leaseOf(A)).toMatchObject({ leaseId: id, state: 'active' })
  })

  it('refuses to take over a device reserved for a waiter, with a reason the tab can show', () => {
    const world = new PoolWorld({ cap: 1 })
    world.device(1, { state: 'ready' })
    world.device(2)
    world.addLease(B, {
      state: 'waiting',
      queue: { position: 1, since: world.wall, waitingFor: 'slot' }
    })
    world.poll()
    const reserved = world.leaseOf(B)
    expect(reserved?.state).toBe('reserved')
    expect(world.takeover(reserved?.leaseId ?? '')).toEqual({ ok: false, reason: 'reserved' })
    const byDevice = world.step({
      kind: 'takeoverDevice',
      udid: udid(1),
      person: 'filip',
      worktreeRoot: ROOT
    })
    expect(byDevice.answer).toMatchObject({
      kind: 'takeover',
      answer: { ok: false, reason: 'reserved' }
    })
  })

  it("makes a person's own lease for a free device, ended when they give it back", () => {
    const world = new PoolWorld()
    world.device(1, { state: 'ready' })
    world.poll()
    const taken = world.step({
      kind: 'takeoverDevice',
      udid: udid(1),
      person: 'filip',
      worktreeRoot: ROOT
    })
    expect(taken.answer).toMatchObject({
      kind: 'takeover',
      answer: { ok: true, lease: { state: 'takeover', holder: { kind: 'human', name: 'filip' } } }
    })
    expect(world.found(udid(1)).state).toBe('leased')
    world.advance(121_000)
    world.poll()
    expect(world.registry.leases).toEqual([])
    world.settleOps()
    expect(world.lease(A)).toMatchObject({ status: 'ready', device: { udid: udid(1) } })
  })
})

describe('reset', () => {
  it('erases the device on the same UDID without a new boot, the brake notwithstanding', () => {
    const world = heldWorld()
    world.capacity.brake = 'brake'
    world.poll()
    expect(world.reset(A, 'device')).toMatchObject({ allow: true, udid: udid(1) })
    expect(world.effects.filter((effect) => effect.kind !== 'writeLeaseFile')).toEqual([
      expect.objectContaining({ kind: 'reset', udid: udid(1) })
    ])
    expect(world.verb(A)).toEqual({
      allow: false,
      refusal: { code: 'device_busy', state: 'resetting' }
    })
    world.capacity.brake = 'emergency'
    world.advance(30_000)
    world.poll()
    expect(world.leaseOf(A)?.state).toBe('active')
    world.finish(udid(1))
    expect(world.verb(A)).toMatchObject({ allow: true, udid: udid(1) })
  })

  it("re-slims for the lease's app and reinstalls the app once the erase is done", () => {
    const world = new PoolWorld({ cap: 2 })
    world.device(1, { state: 'leased' })
    world.addLease(A, { state: 'active', udid: udid(1), app: MAPS })
    world.poll()
    world.reset(A, 'device')
    expect(world.effects).toContainEqual(
      expect.objectContaining({
        kind: 'reset',
        udid: udid(1),
        profile: { app: MAPS, worktreeRoot: ROOT }
      })
    )
    world.finish(udid(1))
    expect(world.effects).toContainEqual({
      kind: 'reinstallApp',
      udid: udid(1),
      leaseId: leaseIdOf(world, A)
    })
  })

  it('answers device_down, not lease_expired, when the erase fails', () => {
    const world = heldWorld()
    world.reset(A, 'device')
    world.finish(udid(1), { ok: false, message: 'erase failed: device busy' })
    expect(world.leaseOf(A)?.state).toBe('active')
    expect(world.verb(A)).toEqual({
      allow: false,
      refusal: {
        code: 'device_down',
        device: 'Portivo-Pod-1',
        state: 'failed',
        problem: 'erase failed: device busy'
      }
    })
  })

  it('resets only the app on `reset app`: no erase, no boot', () => {
    const world = heldWorld()
    world.reset(A, 'app')
    expect(world.effects.filter((effect) => effect.kind !== 'writeLeaseFile')).toEqual([
      { kind: 'resetApp', udid: udid(1), leaseId: leaseIdOf(world, A) }
    ])
    expect(world.found(udid(1)).state).toBe('leased')
  })
})

describe('a removed worktree', () => {
  it('ends every lease in it, waiting, reserved, active or driven', () => {
    const world = new PoolWorld({ cap: 3 })
    const gone = '/Users/dev/portivo-wt/gone'
    world.device(1, { state: 'leased' })
    world.device(2, { state: 'leased' })
    world.device(3, { state: 'ready' })
    world.addLease(A, { state: 'active', udid: udid(1) }, gone)
    world.addLease(
      B,
      { state: 'takeover', udid: udid(2), takeover: { since: world.wall, lastInput: world.wall } },
      gone
    )
    world.addLease(
      C,
      { state: 'reserved', udid: udid(3), reservedUntil: world.wall + 60_000 },
      gone
    )
    world.addLease(
      agent(41009),
      { state: 'waiting', queue: { position: 1, since: world.wall, waitingFor: 'slot' } },
      gone
    )
    world.poll()
    world.step({ kind: 'worktreeRemoved', worktreeRoot: gone })
    expect(world.registry.leases).toEqual([])
    expect(new Set(world.registry.tombstones?.map((ended) => ended.ended.reason))).toEqual(
      new Set(['worktreeRemoved'])
    )
    expect(world.effectKinds()).toEqual(
      expect.arrayContaining([`release ${udid(1)}`, `release ${udid(2)}`])
    )
    expect(world.verb(A, 'read', gone)).toEqual({
      allow: false,
      refusal: { code: 'lease_expired', reason: 'worktreeRemoved' }
    })
    expect(callerOf(A, gone).key).toContain(gone)
  })
})
