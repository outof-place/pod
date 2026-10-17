// Test support for sim-pool-real.test.ts: times every hop of a warm hand-out (registry read, flock,
// token check, write, the pool step, claude-acc's lease file) and every device op of a cold one.
import { runProcess } from '@orca/process-host'
import { writeFileSync } from 'node:fs'
import { claudeAccPaths } from '../claude-acc/sim-claude-acc-paths'
import type { SimPoolPorts } from '../pool/sim-pool-coordinator'
import type { SimDeviceDriver } from '../pool/sim-pool-ports'
import type { SimRegistryTimingPhase } from './sim-registry-file-store'

type Hop = SimRegistryTimingPhase | 'leaseFile' | 'capacity' | 'total'

export type HopTimes = {
  registry(phase: SimRegistryTimingPhase, ms: number): void
  wrap<Ports extends SimPoolPorts>(ports: Ports): Ports
  note(label: string, value: number): void
  startCycle(): void
  endCycle(): void
  report(): void
  guardSees(udid: string): Promise<number>
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? Number.NaN
}

/** `out`: where the report goes (the real test passes its POD_SIM_EVIDENCE directory). */
export function timeHops(out: string): HopTimes {
  const notes: Record<string, number> = {}
  const cycles: Record<Hop, number>[] = []
  let current: Record<Hop, number> | null = null
  let cycleStart = 0
  const add = (hop: Hop, ms: number) => {
    if (current) {
      current[hop] += ms
    }
  }
  const timed = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
    const start = performance.now()
    try {
      return await work()
    } finally {
      notes[label] = Math.round(performance.now() - start)
    }
  }
  return {
    registry: (phase, ms) => add(phase, ms),
    wrap(ports) {
      const devices = ports.devices
      const wrapped: SimDeviceDriver = {
        observe: () => devices.observe(),
        clone: (source, name) => timed('op clone, ms', () => devices.clone(source, name)),
        create: (name, type, runtime) =>
          timed('op create, ms', () => devices.create(name, type, runtime)),
        prepare: (udid, profile) => timed('op prepare, ms', () => devices.prepare(udid, profile)),
        boot: (udid) => timed('op boot, ms', () => devices.boot(udid)),
        shutDown: (udid) => timed('op shutDown, ms', () => devices.shutDown(udid)),
        release: (udid) => timed('op release, ms', () => devices.release(udid)),
        reset: (udid, profile) => timed('op reset, ms', () => devices.reset(udid, profile)),
        delete: (udid) => timed('op delete, ms', () => devices.delete(udid))
      }
      return {
        ...ports,
        devices: wrapped,
        capacity: {
          read: async () => {
            const start = performance.now()
            const reading = await ports.capacity.read()
            add('capacity', performance.now() - start)
            return reading
          }
        },
        leaseFiles: {
          write: async (udid, file) => {
            const start = performance.now()
            await ports.leaseFiles.write(udid, file)
            add('leaseFile', performance.now() - start)
          },
          remove: (udid) => ports.leaseFiles.remove(udid)
        }
      }
    },
    note: (label, value) => {
      notes[label] = Math.round(value)
    },
    startCycle: () => {
      current = { read: 0, lock: 0, check: 0, write: 0, leaseFile: 0, capacity: 0, total: 0 }
      cycleStart = performance.now()
    },
    endCycle: () => {
      if (current) {
        current.total = performance.now() - cycleStart
        cycles.push(current)
        current = null
      }
    },
    report: () => {
      const hops: Hop[] = ['read', 'lock', 'check', 'write', 'leaseFile', 'capacity', 'total']
      const table: Record<string, { p50: number; p95: number; max: number }> = {}
      for (const hop of hops) {
        const values = cycles.map((cycle) => cycle[hop])
        table[hop] = {
          p50: Number(percentile(values, 50).toFixed(2)),
          p95: Number(percentile(values, 95).toFixed(2)),
          max: Number(Math.max(...values).toFixed(2))
        }
      }
      // The step itself: what the total leaves after the I/O hops.
      const step = cycles.map(
        (c) => c.total - c.read - c.lock - c.check - c.write - c.leaseFile - c.capacity
      )
      table.stepAndCoordinator = {
        p50: Number(percentile(step, 50).toFixed(2)),
        p95: Number(percentile(step, 95).toFixed(2)),
        max: Number(Math.max(...step).toFixed(2))
      }
      const result = { cycles: cycles.length, warmHandOutMs: table, notes }
      console.log(JSON.stringify(result, null, 1))
      writeFileSync(out, JSON.stringify(result, null, 1))
    },
    async guardSees(udid) {
      const start = performance.now()
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const status = await runProcess({
          program: claudeAccPaths().binary ?? 'claude-acc',
          args: ['guard', 'status', '--json'],
          timeoutMs: 10_000
        }).catch(() => null)
        const sims: { udid?: string; in_use?: boolean }[] =
          status && status.code === 0 ? (JSON.parse(status.stdout).simulators ?? []) : []
        const seen = sims.find((sim) => sim.udid === udid)
        if (seen) {
          notes['claude-acc guard sees it in_use'] = seen.in_use ? 1 : 0
          return Math.round(performance.now() - start)
        }
        await new Promise((resolve) => setTimeout(resolve, 2_000))
      }
      return -1
    }
  }
}
