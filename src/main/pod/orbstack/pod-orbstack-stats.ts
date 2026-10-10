// Fork-only (Pod): per-machine CPU, memory and disk for `orbstack.stats`. A machine's cgroup v2
// root is its own (OrbStack namespaces it), so one read inside each machine is its whole usage.
import { z } from 'zod'
import type { PodOrbstackMachineStats, PodOrbstackStats } from '../../../shared/pod-orbstack-types'
import { parseOrbMachines } from './pod-orbstack-inventory'
import type { StatsReaders } from './pod-orbstack-stats-readers'
import type { OrbstackToolRunner } from './pod-orbstack-tools'

const TICK_MS = 2_000
const READ_TIMEOUT_MS = 3_000
const DISK_TTL_MS = 30_000
// Why: with readers, machines already read are known running (their `orb` exits with the VM).
const LIST_TTL_MS = 10_000
export const CGROUP_FILES = ['cpu.stat', 'memory.current', 'memory.max', 'memory.stat'].map(
  (file) => `/sys/fs/cgroup/${file}`
)
// Why markers: one `cat` per machine, split back into files on the Mac.
const READ_SCRIPT = `for f in "$@"; do echo "@@ $f"; cat "$f"; done`

const DiskSchema = z.object({ disk_size: z.number().nonnegative() })

/** `orb info` disk sizes, kept 30 s: OrbStack reports them, they move slowly. */
export function createPodOrbstackDiskSizes(deps: { run: OrbstackToolRunner; now?: () => number }) {
  const now = deps.now ?? Date.now
  const cache = new Map<string, { at: number; bytes: Promise<number | null> }>()
  return (name: string): Promise<number | null> => {
    const hit = cache.get(name)
    if (hit && now() - hit.at < DISK_TTL_MS) {
      return hit.bytes
    }
    const bytes = deps.run('orb', ['info', name, '--format', 'json']).then((result) => {
      if (result.code !== 0) {
        return null
      }
      try {
        const parsed = DiskSchema.safeParse(JSON.parse(result.stdout))
        return parsed.success ? parsed.data.disk_size : null
      } catch {
        return null
      }
    })
    cache.set(name, { at: now(), bytes })
    return bytes
  }
}

export type PodOrbstackDiskSizes = ReturnType<typeof createPodOrbstackDiskSizes>

/** Splits the marked `cat` output into per-file text. */
export function parseCgroupRead(
  stdout: string
): Omit<PodOrbstackMachineStats, 'name' | 'diskBytes'> | null {
  const files = new Map<string, string>()
  for (const block of stdout.split(/^@@ /m).slice(1)) {
    const newline = block.indexOf('\n')
    files.set(block.slice(0, newline).trim(), block.slice(newline + 1))
  }
  const field = (text: string | undefined, key: string): number | null => {
    const match = new RegExp(`^${key} (\\d+)$`, 'm').exec(text ?? '')
    return match ? Number(match[1]) : null
  }
  const cpu = field(files.get(CGROUP_FILES[0] ?? ''), 'usage_usec')
  const current = Number((files.get(CGROUP_FILES[1] ?? '') ?? '').trim())
  const max = (files.get(CGROUP_FILES[2] ?? '') ?? '').trim()
  const inactiveFile = field(files.get(CGROUP_FILES[3] ?? ''), 'inactive_file') ?? 0
  if (cpu === null || !Number.isFinite(current) || current <= 0) {
    return null
  }
  return {
    cpuUsageUsec: cpu,
    memoryBytes: Math.max(0, current - inactiveFile),
    memoryLimitBytes: /^\d+$/.test(max) ? Number(max) : null
  }
}

/**
 * Samples every running Pod machine at most once per tick (2 s). Callers inside a tick share its
 * read, so two clients cost what one does.
 */
export function createPodOrbstackStats(deps: {
  run: OrbstackToolRunner
  /** Pod's own machines (registry), templates excluded. */
  podMachines: () => readonly string[]
  /** Machines with a start/stop/delete in flight: never read, since `orb run` would start one. */
  busyMachines?: () => readonly string[]
  diskSizes: PodOrbstackDiskSizes
  /** Long-lived per-machine readers; without them each tick runs one `orb run` per machine. */
  readers?: StatsReaders
  now?: () => number
}) {
  const now = deps.now ?? Date.now
  let tick = 0
  let current: { startedAt: number; result: Promise<PodOrbstackStats> } | null = null
  let listed: { at: number; running: Set<string> } | null = null

  const readCgroups = async (name: string): Promise<{ text: string | null; timedOut: boolean }> => {
    if (deps.readers) {
      const text = await deps.readers.read(name)
      return { text, timedOut: text === null }
    }
    const read = await deps.run(
      'orb',
      ['run', '-m', name, 'sh', '-c', READ_SCRIPT, 'pod-stats', ...CGROUP_FILES],
      { timeoutMs: READ_TIMEOUT_MS }
    )
    return { text: read.code === 0 ? read.stdout : null, timedOut: read.timedOut }
  }

  const readMachine = async (name: string, errors: string[]) => {
    const [read, diskBytes] = await Promise.all([readCgroups(name), deps.diskSizes(name)])
    const usage = read.text === null ? null : parseCgroupRead(read.text)
    if (!usage) {
      errors.push(`${name}: ${read.timedOut ? 'timed out' : 'could not read its usage'}`)
      return null
    }
    return { name, ...usage, diskBytes }
  }

  /** Running machines from `orb list`, skipped while every candidate already has a reader. */
  const runningMachines = async (candidates: string[]): Promise<Set<string> | null> => {
    const known = deps.readers
      ? candidates.every((name) => deps.readers?.has(name) || listed?.running.has(name) === false)
      : false
    if (known && listed && now() - listed.at < LIST_TTL_MS) {
      return new Set(candidates.filter((name) => deps.readers?.has(name)))
    }
    const result = await deps.run('orb', ['list', '--format', 'json'])
    const machines = result.code === 0 ? parseOrbMachines(result.stdout) : null
    if (!machines) {
      return null
    }
    const running = new Set(machines.filter((m) => m.state === 'running').map((m) => m.name))
    listed = { at: now(), running }
    return running
  }

  const sample = async (): Promise<PodOrbstackStats> => {
    tick += 1
    const sampledAt = now()
    const errors: string[] = []
    const busy = new Set(deps.busyMachines?.() ?? [])
    const candidates = deps.podMachines().filter((name) => !busy.has(name))
    const running = await runningMachines(candidates)
    if (!running) {
      return { tick, sampledAt, machines: [], errors: ['orb list failed'] }
    }
    // Only machines already running: `orb run` on a stopped one would start it.
    const names = candidates.filter((name) => running.has(name))
    deps.readers?.retain(new Set(names))
    const rows = await Promise.all(names.map((name) => readMachine(name, errors)))
    return {
      tick,
      sampledAt,
      machines: rows.filter((row) => row !== null),
      errors
    }
  }

  return {
    /** After a change Pod made: the next tick lists machines again. */
    invalidate: (): void => {
      listed = null
    },
    /** `names` filters the tick's rows; it never adds reads. */
    read: async (names?: readonly string[]): Promise<PodOrbstackStats> => {
      if (!current || now() - current.startedAt >= TICK_MS) {
        const result = sample()
        current = { startedAt: now(), result }
        result.catch(() => {
          current = null
        })
      }
      const stats = await current.result
      if (!names) {
        return stats
      }
      const wanted = new Set(names)
      const owned = new Set(deps.podMachines())
      return {
        ...stats,
        machines: stats.machines.filter((machine) => wanted.has(machine.name)),
        errors: [
          ...stats.errors,
          ...names.filter((name) => !owned.has(name)).map((name) => `${name} is not a Pod machine`)
        ]
      }
    }
  }
}

export type PodOrbstackStatsReader = ReturnType<typeof createPodOrbstackStats>
