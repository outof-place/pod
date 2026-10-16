import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { SIM_WAITER_ABANDON_S } from '../../../../shared/pod-sim/sim-call-limits'
import type { SimHolder } from '../../../../shared/pod-sim/sim-holder'
import {
  SIM_DEVICE_EVENTS,
  SIM_DEVICE_STATES,
  SIM_DEVICE_TRANSITIONS,
  SIM_LEASE_EVENTS,
  SIM_LEASE_STATES,
  SIM_LEASE_TRANSITIONS
} from '../../../../shared/pod-sim/sim-lifecycle'
import type { SimDeviceOp } from './sim-pool-config'
import { agent, PoolWorld, ROOT, udid } from './sim-pool.test-support'

// The fixture is decoded by the contract's own state and event lists: a row naming a state or an
// event the contract does not have fails here, before any walk runs.
const DeviceRow = {
  machine: z.literal('device'),
  from: z.enum(SIM_DEVICE_STATES),
  event: z.enum(SIM_DEVICE_EVENTS),
  to: z.enum(SIM_DEVICE_STATES)
}
const LeaseRow = {
  machine: z.literal('lease'),
  from: z.enum(SIM_LEASE_STATES),
  event: z.enum(SIM_LEASE_EVENTS),
  to: z.enum(SIM_LEASE_STATES)
}
const Taken = z.discriminatedUnion('machine', [
  z.strictObject({ ...DeviceRow, when: z.string().min(1) }),
  z.strictObject({ ...LeaseRow, when: z.string().min(1) })
])
const NotTaken = z.discriminatedUnion('machine', [
  z.strictObject({ ...DeviceRow, why: z.string().min(1) }),
  z.strictObject({ ...LeaseRow, why: z.string().min(1) })
])
const fixture = z
  .strictObject({ taken: z.array(Taken), notTaken: z.array(NotTaken) })
  .parse(JSON.parse(readFileSync(join(__dirname, 'fixtures', 'core-transitions.json'), 'utf8')))

type Row = Readonly<{ machine: string; from: string; event: string; to: string }>
const keyOf = (row: Row): string => `${row.machine} ${row.from} --${row.event}--> ${row.to}`

const A = agent(45001)
const B = agent(45002)
const C = agent(45003)
const D = agent(45004)
const E = agent(45005)
const OTHER = '/Users/dev/portivo-wt/other'
const THIRD = '/Users/dev/portivo-wt/third'
const FAILED = { ok: false, message: 'simctl exited 1' } as const

function leaseIdOf(world: PoolWorld, holder: SimHolder, root = ROOT): string {
  const lease = world.leaseOf(holder, root)
  if (!lease) {
    throw new Error(`${holder.id} holds no lease`)
  }
  return lease.leaseId
}

function inFlight(world: PoolWorld, kind: SimDeviceOp): string {
  const device = world.registry.devices.find((candidate) => candidate.op?.kind === kind)
  if (!device) {
    throw new Error(`no ${kind} in flight`)
  }
  return device.udid
}

function shutDownOutside(world: PoolWorld, n: number): void {
  world.observed.set(udid(n), { udid: udid(n), name: `Portivo-Pod-${n}`, state: 'shutdown' })
}

/** Each walk drives the core through a few rules; together they must take every row in `taken`. */
const WALKS: Record<string, () => PoolWorld> = {
  'a warm device is reserved, claimed and given back; the next release fails': () => {
    const world = new PoolWorld()
    world.device(1, { state: 'ready' })
    world.poll()
    world.lease(A)
    world.release(A)
    world.finish(udid(1))
    world.lease(B)
    world.release(B)
    world.finish(udid(1), FAILED)
    return world
  },
  'cold devices boot for waiters; a boot fails and simctl then shows the device shut down': () => {
    const world = new PoolWorld()
    world.device(1)
    world.device(2)
    world.poll()
    world.lease(A)
    world.finish(udid(1))
    world.lease(A)
    world.lease(B)
    world.finish(udid(2), FAILED)
    world.advance(1_000)
    world.poll()
    return world
  },
  'a failed device simctl still shows booted is shut down': () => {
    const world = new PoolWorld()
    world.device(1, { state: 'failed' })
    world.poll()
    world.finish(udid(1))
    return world
  },
  'an unheld device past its warm window shuts down, and the shutdown fails': () => {
    const world = new PoolWorld()
    world.device(1, { state: 'ready' })
    world.poll()
    world.advance(world.config.warmMs)
    world.poll()
    world.finish(udid(1), FAILED)
    return world
  },
  'the brake at tight ends an idle lease and its device shuts down': () => {
    const world = new PoolWorld()
    world.device(1, { state: 'ready' })
    world.poll()
    world.lease(A)
    world.advance(world.config.idleMs)
    world.capacity.brake = 'tight'
    world.poll()
    return world
  },
  'a device reset keeps its UDID, and a second reset fails': () => {
    const world = new PoolWorld()
    world.device(1, { state: 'ready' })
    world.poll()
    world.lease(A)
    world.reset(A, 'device')
    world.finish(udid(1))
    world.reset(A, 'device')
    world.finish(udid(1), FAILED)
    return world
  },
  'a device cloned from the golden one is slimmed and booted; a second clone fails': () => {
    const world = new PoolWorld()
    world.device(1, { role: 'golden' })
    world.poll()
    world.lease(A)
    world.settleOps()
    world.lease(B)
    world.finish(inFlight(world, 'clone'), FAILED)
    return world
  },
  'a device made from scratch fails slimming and is deleted once shut down': () => {
    const world = new PoolWorld()
    world.poll()
    world.advance(1_000)
    world.lease(A)
    world.finish(inFlight(world, 'create'))
    world.finish(inFlight(world, 'prepare'), FAILED)
    world.advance(1_000)
    world.poll()
    world.finish(inFlight(world, 'delete'))
    return world
  },
  'a held device shut down outside Pod boots again for its lease': () => {
    const world = new PoolWorld()
    world.device(1, { state: 'ready' })
    world.poll()
    world.lease(A)
    shutDownOutside(world, 1)
    world.advance(1_000)
    world.poll()
    world.finish(udid(1))
    return world
  },
  'devices gone from the set: held, taken over, shut down, not yet slimmed; one shut down': () => {
    const world = new PoolWorld()
    world.device(1, { state: 'ready' })
    world.device(2, { state: 'ready' })
    world.device(3)
    world.device(4, { state: 'preparing' })
    world.device(5, { state: 'ready' })
    world.observed.delete(udid(4))
    world.poll()
    world.lease(A)
    world.lease(B)
    world.takeover(leaseIdOf(world, B))
    for (const n of [1, 2, 3]) {
      world.observed.delete(udid(n))
    }
    shutDownOutside(world, 5)
    world.advance(1_000)
    world.poll()
    return world
  },
  'waiters that leave: released, exited, failed build, removed worktree, silent': () => {
    // No device and none the pool may make: everyone waits.
    const world = new PoolWorld({ config: { deviceTypes: {} } })
    world.poll()
    world.lease(A)
    world.lease(B)
    world.lease(C, { buildId: 'sb_build1' })
    world.lease(D, { worktreeRoot: OTHER })
    world.lease(E)
    world.release(A)
    world.liveness[leaseIdOf(world, B)] = 'exited'
    world.advance(1_000)
    world.poll()
    world.step({ kind: 'buildFinished', buildId: 'sb_build1', ok: false })
    world.step({ kind: 'worktreeRemoved', worktreeRoot: OTHER })
    world.advance(SIM_WAITER_ABANDON_S * 1000)
    world.poll()
    return world
  },
  'reservations that lapse and end: released, exited, removed worktree': () => {
    const world = new PoolWorld({ cap: 4 })
    for (const n of [1, 2, 3, 4]) {
      world.device(n)
    }
    world.poll()
    world.lease(A)
    world.lease(B)
    world.lease(C, { worktreeRoot: OTHER })
    world.settleOps()
    world.advance(61_000)
    world.poll()
    world.release(A)
    world.liveness[leaseIdOf(world, B)] = 'exited'
    world.advance(1_000)
    world.poll()
    world.step({ kind: 'worktreeRemoved', worktreeRoot: OTHER })
    return world
  },
  'active leases that end, and takeovers from start to end': () => {
    const world = new PoolWorld({ cap: 4 })
    for (const n of [1, 2, 3, 4]) {
      world.device(n, { state: 'ready' })
    }
    world.poll()
    world.lease(A)
    world.lease(B)
    world.lease(C, { worktreeRoot: THIRD })
    world.lease(D, { worktreeRoot: OTHER })
    world.liveness[leaseIdOf(world, A)] = 'exited'
    world.advance(1_000)
    world.poll()
    world.step({ kind: 'worktreeRemoved', worktreeRoot: OTHER })
    world.takeover(leaseIdOf(world, B))
    world.step({ kind: 'giveBack', leaseId: leaseIdOf(world, B) })
    world.takeover(leaseIdOf(world, B))
    world.release(B)
    world.takeover(leaseIdOf(world, C, THIRD))
    world.liveness[leaseIdOf(world, C, THIRD)] = 'exited'
    world.advance(1_000)
    world.poll()
    world.step({ kind: 'worktreeRemoved', worktreeRoot: THIRD })
    return world
  }
}

describe('the transitions the core takes', () => {
  it('names each contract transition once: taken by the core, or not and why', () => {
    const contract = [
      ...SIM_DEVICE_TRANSITIONS.map((row) => keyOf({ machine: 'device', ...row })),
      ...SIM_LEASE_TRANSITIONS.map((row) => keyOf({ machine: 'lease', ...row }))
    ].sort()
    const named = [...fixture.taken, ...fixture.notTaken].map(keyOf).sort()
    expect(named).toEqual(contract)
  })

  it('takes every transition the fixture lists as taken, and no other', () => {
    const seen = new Set<string>()
    for (const walk of Object.values(WALKS)) {
      for (const row of walk().traces) {
        seen.add(keyOf(row))
      }
    }
    expect([...seen].sort()).toEqual(fixture.taken.map(keyOf).sort())
  })
})
