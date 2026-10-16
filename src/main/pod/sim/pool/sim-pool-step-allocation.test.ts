// Runs under Node (V8, as the runtime does): `*allocation*.test.ts` is a node-runtime file.
// Budget (COMMON-BRIEF "Performance is the product"): one decision step over 35 holders and 10
// devices under 1 ms at p95, allocating under 128 KB. Fails above it; prints what it measured.
import v8 from 'node:v8'
import { describe, expect, it } from 'vitest'
import { simLeaseKey } from '../../../../shared/pod-sim/sim-holder'
import type { SimPoolCommand } from './sim-pool-commands'
import { SIM_POOL_DEFAULTS } from './sim-pool-config'
import { EMPTY_SIM_POOL_MEMORY, type SimPoolRegistry } from './sim-pool-draft'
import { simPoolStep, type SimPoolState } from './sim-pool-step'
import { agent, IPHONE, ROOT, SELF, T0, udid } from './sim-pool.test-support'

const STEP_BUDGET_MS = 1
// Measured 48 to 81 KB on 2026-10-17 (Node 26, M-series); the old JSON-clone step took ~600 KB.
const ALLOCATION_BUDGET_BYTES = 128 * 1024

function busyDay(): SimPoolRegistry {
  const devices = Array.from({ length: 10 }, (_, index) => ({
    udid: udid(index + 1),
    name: `Portivo-Pod-${index + 1}`,
    role: 'pool' as const,
    deviceType: IPHONE,
    runtime: 'iOS 26.5',
    createdAt: T0 - 86_400_000,
    state: index < 8 ? ('leased' as const) : ('shutdown' as const),
    affinity: `${ROOT}-${index}`
  }))
  const leases = Array.from({ length: 35 }, (_, index) => {
    const holder = agent(43000 + index)
    const root = `${ROOT}-${index}`
    return {
      leaseId: `sl_b${index.toString().padStart(3, '0')}`,
      key: simLeaseKey(holder.id, root),
      state: index < 8 ? ('active' as const) : ('waiting' as const),
      holder,
      worktreeRoot: root,
      since: T0 - 600_000 + index,
      lastActivity: T0 - 1_000,
      ...(index < 8
        ? { udid: udid(index + 1) }
        : {
            queue: { position: index - 7, since: T0 - 600_000 + index, waitingFor: 'slot' as const }
          }),
      wants: { deviceClass: 'iphone' as const },
      servedBy: SELF
    }
  })
  const tombstones = Array.from({ length: 100 }, (_, index) => ({
    ...leases[index % 35],
    leaseId: `sl_t${index.toString().padStart(3, '0')}`,
    key: `agent:claude:${50000 + index}:1760600000@${ROOT}`,
    state: 'expired' as const,
    ended: { at: T0 - 3_600_000 + index, reason: 'idleForWaiter' as const }
  }))
  return { version: 1, updatedAt: T0 - 5_000, devices, leases, tombstones }
}

const inputs = {
  now: { mono: 5_000_000, wall: T0 },
  self: SELF,
  config: {
    namePrefix: 'Portivo-',
    ...SIM_POOL_DEFAULTS,
    deviceTypes: { iphone: { deviceType: IPHONE, runtime: 'iOS 26.5' } }
  },
  openCalls: new Set<string>(),
  ids: { leaseId: () => 'sl_new1', deviceId: () => udid(9999) }
}

function steadyState(): SimPoolState {
  const registry = busyDay()
  const poll: SimPoolCommand = {
    kind: 'poll',
    observation: {
      at: { mono: 4_999_000, wall: T0 - 1_000 },
      devices: {
        verdict: 'ok',
        devices: registry.devices.map((device) => ({
          udid: device.udid,
          name: device.name,
          state: device.state === 'leased' ? 'booted' : 'shutdown'
        }))
      },
      capacity: {
        source: 'claudeAcc',
        cap: 8,
        outsideBooted: 0,
        brake: 'calm',
        measuredAt: T0 - 1_000
      },
      liveness: Object.fromEntries(registry.leases.map((lease) => [lease.leaseId, 'live'])),
      runtimes: {},
      externalUse: []
    }
  }
  const first = simPoolStep(
    { registry, memory: structuredClone(EMPTY_SIM_POOL_MEMORY) },
    poll,
    inputs
  )
  return { registry: first.registry, memory: first.memory }
}

/** Bytes allocated so far: V8's exact counter where Node has it (26), else live heap growth. */
function allocatedSoFar(): number {
  const stats: object = v8.getHeapStatistics()
  if ('total_allocated_bytes' in stats && typeof stats.total_allocated_bytes === 'number') {
    return stats.total_allocated_bytes
  }
  return process.memoryUsage().heapUsed
}

function measure(
  state: SimPoolState,
  command: SimPoolCommand
): { p50: number; p95: number; bytes: number } {
  for (let warm = 0; warm < 200; warm += 1) {
    simPoolStep(state, command, inputs)
  }
  const times: number[] = []
  for (let run = 0; run < 500; run += 1) {
    const start = performance.now()
    simPoolStep(state, command, inputs)
    times.push(performance.now() - start)
  }
  times.sort((a, b) => a - b)
  const before = allocatedSoFar()
  const kept: unknown[] = []
  for (let run = 0; run < 50; run += 1) {
    kept.push(simPoolStep(state, command, inputs))
  }
  return { p50: times[250], p95: times[475], bytes: (allocatedSoFar() - before) / kept.length }
}

describe('one decision step over 35 holders and 10 devices', () => {
  const state = steadyState()
  const waiter = state.registry.leases[20]
  const holder = state.registry.leases[2]
  const cases: [string, SimPoolCommand][] = [
    ['a poll', { kind: 'poll', observation: state.memory.observation! }],
    [
      'a waiter calling again',
      {
        kind: 'lease',
        request: { key: waiter.key, holder: waiter.holder, worktreeRoot: waiter.worktreeRoot }
      }
    ],
    [
      'a holder tapping',
      {
        kind: 'verb',
        caller: { key: holder.key, holder: holder.holder, worktreeRoot: holder.worktreeRoot },
        verb: 'tap',
        access: 'input'
      }
    ],
    [
      'a release',
      {
        kind: 'release',
        caller: { key: holder.key, holder: holder.holder, worktreeRoot: holder.worktreeRoot }
      }
    ]
  ]
  for (const [name, command] of cases) {
    it(`${name} decides in under ${STEP_BUDGET_MS} ms`, () => {
      const { p50, p95, bytes } = measure(state, command)
      process.stdout.write(
        `sim-pool step, ${name}: p50 ${p50.toFixed(3)} ms, p95 ${p95.toFixed(3)} ms, ~${Math.round(bytes / 1024)} KB/step\n`
      )
      expect(p95).toBeLessThan(STEP_BUDGET_MS)
      expect(bytes).toBeLessThan(ALLOCATION_BUDGET_BYTES)
    })
  }
})
