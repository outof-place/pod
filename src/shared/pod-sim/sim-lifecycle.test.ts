import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  SIM_DEVICE_EVENTS,
  SIM_DEVICE_STATES,
  SIM_DEVICE_TRANSITIONS,
  SIM_LEASE_EVENTS,
  SIM_LEASE_STATES,
  SIM_LEASE_TRANSITIONS,
  simDeviceCountsTowardCap,
  simDeviceIsFree,
  simDeviceTransition,
  simLeaseIsFinal,
  simLeaseTransition,
  type SimDeviceEvent,
  type SimDeviceState,
  type SimLeaseEvent,
  type SimLeaseState
} from './sim-lifecycle'

const Row = z.object({ from: z.string(), event: z.string(), to: z.string() }).strict()
const DeviceState = z.enum(SIM_DEVICE_STATES)
const LeaseState = z.enum(SIM_LEASE_STATES)
const Fixture = z
  .object({
    device: z.array(Row),
    lease: z.array(Row),
    illegal: z.array(
      z
        .object({
          machine: z.enum(['device', 'lease']),
          from: z.string(),
          event: z.string(),
          refused: z.string()
        })
        .strict()
    ),
    walks: z.array(
      z
        .object({
          name: z.string(),
          machine: z.enum(['device', 'lease']),
          start: z.string(),
          events: z.array(z.string()).min(1),
          states: z.array(z.string()).min(1)
        })
        .strict()
    ),
    free: z.array(
      z
        .object({
          name: z.string(),
          device: z
            .object({ udid: z.string(), role: z.enum(['golden', 'pool']), state: DeviceState })
            .strict(),
          leases: z.array(z.object({ udid: z.string().optional(), state: LeaseState }).strict()),
          free: z.boolean()
        })
        .strict()
    )
  })
  .strict()
const fixture = Fixture.parse(
  JSON.parse(readFileSync(join(__dirname, 'fixtures', 'transitions.json'), 'utf8'))
)

const keyOf = (row: { from: string; event: string }): string => `${row.from} --${row.event}-->`

function step(machine: 'device' | 'lease', from: string, event: string): string | null {
  const outcome =
    machine === 'device'
      ? simDeviceTransition(DeviceState.parse(from), z.enum(SIM_DEVICE_EVENTS).parse(event))
      : simLeaseTransition(LeaseState.parse(from), z.enum(SIM_LEASE_EVENTS).parse(event))
  return outcome.ok ? outcome.to : null
}

/** The states reachable from `start` through the given events only (start included). */
function reachable<State extends string, Event extends string>(
  table: readonly { from: State; event: Event; to: State }[],
  start: State,
  events: ReadonlySet<Event>
): Set<State> {
  const seen = new Set<State>([start])
  const frontier = [start]
  for (let state = frontier.pop(); state !== undefined; state = frontier.pop()) {
    for (const row of table) {
      if (row.from === state && events.has(row.event) && !seen.has(row.to)) {
        seen.add(row.to)
        frontier.push(row.to)
      }
    }
  }
  return seen
}

describe('the frozen transition tables', () => {
  it('device: every fixture transition is in the table and nothing else is', () => {
    expect(SIM_DEVICE_TRANSITIONS.map((row) => ({ ...row }))).toEqual(fixture.device)
  })

  it('lease: every fixture transition is in the table and nothing else is', () => {
    expect(SIM_LEASE_TRANSITIONS.map((row) => ({ ...row }))).toEqual(fixture.lease)
  })

  it('device: each transition lands where the fixture says', () => {
    for (const row of fixture.device) {
      expect(step('device', row.from, row.event), keyOf(row)).toBe(row.to)
    }
  })

  it('lease: each transition lands where the fixture says', () => {
    for (const row of fixture.lease) {
      expect(step('lease', row.from, row.event), keyOf(row)).toBe(row.to)
    }
  })

  it('refuses the listed illegal transitions with the named reason', () => {
    for (const row of fixture.illegal) {
      const outcome =
        row.machine === 'device'
          ? simDeviceTransition(
              DeviceState.parse(row.from),
              z.enum(SIM_DEVICE_EVENTS).parse(row.event)
            )
          : simLeaseTransition(
              LeaseState.parse(row.from),
              z.enum(SIM_LEASE_EVENTS).parse(row.event)
            )
      expect(outcome, `${row.machine} ${keyOf(row)}`).toEqual({ ok: false, reason: row.refused })
    }
  })

  it('refuses every pair outside the tables with one reason per blocking state', () => {
    const named = new Map(fixture.illegal.map((row) => [`${row.machine}:${row.from}`, row.refused]))
    const deviceReasons = new Map<string, Set<string>>()
    const allowedDevice = new Set(fixture.device.map(keyOf))
    for (const from of SIM_DEVICE_STATES) {
      for (const event of SIM_DEVICE_EVENTS) {
        if (allowedDevice.has(keyOf({ from, event }))) {
          continue
        }
        const outcome = simDeviceTransition(from, event)
        if (outcome.ok) {
          throw new Error(`device ${keyOf({ from, event })} should be refused`)
        }
        deviceReasons.set(from, (deviceReasons.get(from) ?? new Set()).add(outcome.reason))
      }
    }
    const leaseReasons = new Map<string, Set<string>>()
    const allowedLease = new Set(fixture.lease.map(keyOf))
    for (const from of SIM_LEASE_STATES) {
      for (const event of SIM_LEASE_EVENTS) {
        if (allowedLease.has(keyOf({ from, event }))) {
          continue
        }
        const outcome = simLeaseTransition(from, event)
        if (outcome.ok) {
          throw new Error(`lease ${keyOf({ from, event })} should be refused`)
        }
        leaseReasons.set(from, (leaseReasons.get(from) ?? new Set()).add(outcome.reason))
      }
    }
    for (const [machine, reasons] of [
      ['device', deviceReasons],
      ['lease', leaseReasons]
    ] as const) {
      for (const [from, names] of reasons) {
        expect([...names], `${machine} ${from}`).toHaveLength(1)
        expect([...names][0], `${machine} ${from}`).toBe(named.get(`${machine}:${from}`))
      }
    }
  })

  it('every state and event appears in some transition', () => {
    const deviceSeen = new Set(fixture.device.flatMap((row) => [row.from, row.to]))
    expect([...SIM_DEVICE_STATES].filter((state) => !deviceSeen.has(state))).toEqual([])
    expect(
      [...SIM_DEVICE_EVENTS].filter((event) => !fixture.device.some((row) => row.event === event))
    ).toEqual([])
    const leaseSeen = new Set(fixture.lease.flatMap((row) => [row.from, row.to]))
    expect([...SIM_LEASE_STATES].filter((state) => !leaseSeen.has(state))).toEqual([])
    expect(
      [...SIM_LEASE_EVENTS].filter((event) => !fixture.lease.some((row) => row.event === event))
    ).toEqual([])
  })

  for (const walk of fixture.walks) {
    it(`walks: ${walk.name}`, () => {
      const states: (string | null)[] = []
      let state: string | null = walk.start
      for (const event of walk.events) {
        state = state === null ? null : step(walk.machine, state, event)
        states.push(state)
      }
      expect(states).toEqual(walk.states)
    })
  }

  // simslim boots a device to slim it, so a preparing device holds a slot too.
  it('a device counts toward the boot cap whenever its launchd_sim may exist', () => {
    expect(SIM_DEVICE_STATES.filter(simDeviceCountsTowardCap)).toEqual([
      'preparing',
      'booting',
      'ready',
      'leased',
      'resetting',
      'releasing',
      'shuttingDown',
      'failed'
    ])
  })
})

describe('properties of the tables', () => {
  const booted = SIM_DEVICE_STATES.filter(simDeviceCountsTowardCap)
  const deviceEvents = new Set<SimDeviceEvent>(SIM_DEVICE_EVENTS)

  it('every booted state can fail and be lost, and leaves its boot slot either way', () => {
    for (const from of booted) {
      for (const event of ['fail', 'lost'] as const) {
        if (from === 'failed' && event === 'fail') {
          continue
        }
        const to = step('device', from, event)
        expect(to, `${from} --${event}-->`).not.toBeNull()
        const after = reachable(SIM_DEVICE_TRANSITIONS, DeviceState.parse(to), deviceEvents)
        expect(
          [...after].some((state) => !simDeviceCountsTowardCap(state)),
          `${from} --${event}--> ${to} never gives its slot back`
        ).toBe(true)
      }
    }
  })

  // The holder's own calls (claim, release) and its death need it; an alive, silent holder does
  // neither, so each live lease needs a way out that Pod's timers and the person drive alone.
  const holderEvents = new Set<SimLeaseEvent>(['claim', 'release', 'holderExited'])
  const podEvents = new Set(SIM_LEASE_EVENTS.filter((event) => !holderEvents.has(event)))

  it('every live lease reaches an end without its holder', () => {
    for (const from of SIM_LEASE_STATES.filter((state) => !simLeaseIsFinal(state))) {
      const ends = [...reachable(SIM_LEASE_TRANSITIONS, from, podEvents)].filter(simLeaseIsFinal)
      expect(ends, `${from} waits on its holder forever`).not.toEqual([])
    }
  })

  it('a device named by a live lease is never offered, whatever the device went through', () => {
    // Everything a leased device can go through while its lease stays live (no release).
    const whileLeased = new Set(SIM_DEVICE_EVENTS.filter((event) => event !== 'release'))
    const states: SimDeviceState[] = [...reachable(SIM_DEVICE_TRANSITIONS, 'leased', whileLeased)]
    expect(states, 'a leased device that is lost and recovered comes back ready').toContain('ready')
    const live: SimLeaseState[] = SIM_LEASE_STATES.filter((state) => !simLeaseIsFinal(state))
    for (const state of states) {
      for (const leaseState of live) {
        const device = { udid: 'U', role: 'pool', state } as const
        expect(
          simDeviceIsFree(device, [{ udid: 'U', state: leaseState }]),
          `${state} with a ${leaseState} lease`
        ).toBe(false)
      }
    }
  })

  for (const { name, device, leases, free } of fixture.free) {
    it(`free: ${name}`, () => {
      expect(simDeviceIsFree(device, leases)).toBe(free)
    })
  }
})
