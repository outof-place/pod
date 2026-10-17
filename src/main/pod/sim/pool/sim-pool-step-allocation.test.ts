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
// Measured 58 to 92 KB on 2026-10-17 (Node 26, M-series); the old JSON-clone step took ~600 KB.
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
  now: { mono: 5_000_000, wall: T0, suspends: 0, suspended: false },
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
      at: { mono: 4_999_000, wall: T0 - 1_000, suspends: 0, suspended: false },
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
        agentsInUse: 'unknown',
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

/** V8's own count of every byte allocated so far, where the runtime has it (Node 26). */
function allocationCounter(): (() => number) | null {
  const read = (): unknown => {
    const stats: object = v8.getHeapStatistics()
    return 'total_allocated_bytes' in stats ? stats.total_allocated_bytes : undefined
  }
  return typeof read() === 'number' ? () => Number(read()) : null
}

/**
 * Bytes one step allocates, over 50 steps. Node 26 counts them; Node 24 (CI) and Electron 45 do
 * not, so there it is the heap's growth plus what every collection in between freed
 * (v8.GCProfiler reports the heap before and after each), which read 10 to 20% under Node 26's
 * count. Reading the heap right after a forced GC (--expose-gc) is no substitute: a full GC drops
 * compiled code and feedback, so the next step allocates them again and read twice its size.
 */
function bytesPerStep(state: SimPoolState, command: SimPoolCommand): number {
  const runs = 50
  const counter = allocationCounter()
  if (counter) {
    const before = counter()
    for (let run = 0; run < runs; run += 1) {
      simPoolStep(state, command, inputs)
    }
    return (counter() - before) / runs
  }
  const profiler = new v8.GCProfiler()
  profiler.start()
  const before = v8.getHeapStatistics().used_heap_size
  for (let run = 0; run < runs; run += 1) {
    simPoolStep(state, command, inputs)
  }
  const after = v8.getHeapStatistics().used_heap_size
  let freed = 0
  for (const gc of profiler.stop().statistics) {
    freed += gc.beforeGC.heapStatistics.usedHeapSize - gc.afterGC.heapStatistics.usedHeapSize
  }
  return (after - before + freed) / runs
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
  return { p50: times[250], p95: times[475], bytes: bytesPerStep(state, command) }
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
