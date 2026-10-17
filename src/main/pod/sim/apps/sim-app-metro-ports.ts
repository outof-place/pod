// Fork-only (Pod): which port each worktree's Metro runs on. `metro.json` in the simulator home
// keeps the plan Mac-wide (compare-and-swap under its flock, like the registry), so the port stays
// the worktree's across calls and runtime restarts and differs between worktrees: a repo's main
// checkout gets the recipe's port, every other worktree the lowest port from the recipe's port plus
// SIM_METRO_WORKTREE_OFFSET that no other worktree holds and nothing else listens on. A port another
// program has taken since is given up for the next free one. A server record this runtime cannot
// read (a newer Pod's) is skipped, its port still taken, and written back as it was.
import { z } from 'zod'
import { SimRuntimeRef } from '../../../../shared/pod-sim/sim-registry'
import { createSimJsonFile, simReadRecords, type SimJsonFile } from './sim-app-json-file'
import type { SimMetroProbe } from './sim-app-metro-http'
import type { SimAppHome } from './sim-app-paths'
import type { SimSpawnedRef } from './sim-app-spawn'

/**
 * Worktrees other than the main checkout start this far above the recipe's port: clear of
 * portivo-mobile's worktree ports (recipe port plus 100 and up) while both run on one Mac.
 */
export const SIM_METRO_WORKTREE_OFFSET = 300
const PORT_SPAN = 900
/** A recipe's Metro without a port: React Native's own default. */
const DEFAULT_PORT = 8081

const SimMetroRecord = z.looseObject({
  worktreeRoot: z.string().min(1),
  appId: z.string().min(1).max(64),
  appDir: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  assignedAt: z.number().int().nonnegative(),
  // The Metro Pod started for it (a Metro Pod did not start has none): its kernel start once `ps`
  // read it, and `since`, the wall time it was spawned at.
  process: z
    .looseObject({
      pid: z.number().int().positive(),
      startedAt: z.number().int().nonnegative().optional(),
      since: z.number().int().nonnegative(),
      by: SimRuntimeRef
    })
    .optional(),
  starting: z.looseObject({ by: SimRuntimeRef, at: z.number().int().nonnegative() }).optional(),
  // When the last live lease of this worktree and app was seen gone.
  idleSince: z.number().int().nonnegative().optional()
})
export type SimMetroRecord = z.infer<typeof SimMetroRecord>

const SimMetroFileLayout = z.looseObject({ version: z.literal(1), servers: z.array(z.unknown()) })
// Keys a newer Pod added at the top ride along in the value and are written back.
export type SimMetroFile = {
  version: 1
  servers: SimMetroRecord[]
  // Records this runtime cannot read, written back as they were.
  unread: unknown[]
}

export function createSimMetroFile(home: SimAppHome): SimJsonFile<SimMetroFile> {
  return createSimJsonFile<SimMetroFile>({
    path: home.metro,
    lock: home.metroLock,
    parse: (json) => {
      const file = SimMetroFileLayout.safeParse(json)
      if (!file.success) {
        return null
      }
      const { known, unread } = simReadRecords(file.data.servers, (record) => {
        const server = SimMetroRecord.safeParse(record)
        return server.success ? server.data : null
      })
      return { ...file.data, servers: known, unread }
    },
    serialize: ({ unread, ...value }) => ({ ...value, servers: [...value.servers, ...unread] }),
    empty: () => ({ version: 1, servers: [], unread: [] })
  })
}

/** The Metro process Pod started for a record, as the process control checks it. */
export function simMetroProcess(record: SimMetroRecord): SimSpawnedRef | null {
  const server = record.process
  return server
    ? {
        pid: server.pid,
        ...(server.startedAt !== undefined ? { startedAt: server.startedAt } : {}),
        spawnedAt: server.since
      }
    : null
}

/** The port a record holds, read or not. */
function portOf(record: unknown): number | null {
  const port =
    record !== null && typeof record === 'object' && 'port' in record ? record.port : null
  return typeof port === 'number' ? port : null
}

export function simMetroKey(record: Readonly<{ worktreeRoot: string; appId: string }>): string {
  return `${record.worktreeRoot}\u0000${record.appId}`
}

/** Someone else is starting it: wait for theirs instead of starting another. */
export const SIM_METRO_STARTING_FRESH_MS = 60_000

/** The keys among these with no Metro process of Pod's recorded and none starting. */
export function simMetroUnstarted(
  file: SimMetroFile,
  keys: Iterable<string>,
  at: number
): string[] {
  return [...keys].filter((key) => {
    const record = file.servers.find((other) => simMetroKey(other) === key)
    const starting = record?.starting && at - record.starting.at < SIM_METRO_STARTING_FRESH_MS
    return !record?.process && !starting
  })
}

export type SimMetroPortInput = Readonly<{
  worktreeRoot: string
  appId: string
  // The recipe's `metro.port`.
  base: number | undefined
  // The repo's main checkout (or a folder workspace): the recipe's own port.
  main: boolean
}>

export type SimMetroPortPlan = Readonly<{
  file: SimJsonFile<SimMetroFile>
  probe: (port: number, appDir: string) => Promise<SimMetroProbe>
  now: () => number
}>

/** The worktree's port: kept, or the first free one written for it; else why there is none. */
export async function planSimMetroPort(
  plan: SimMetroPortPlan,
  input: SimMetroPortInput,
  appDir: string,
  avoid?: number
): Promise<SimMetroRecord | string> {
  const base = input.base ?? DEFAULT_PORT
  const read = await plan.file.read()
  if (!read.ok) {
    return read.message
  }
  const key = simMetroKey(input)
  const existing = read.value.servers.find((record) => simMetroKey(record) === key)
  if (existing && existing.port !== avoid) {
    return existing
  }
  const taken = new Set([
    ...read.value.servers
      .filter((record) => simMetroKey(record) !== key)
      .map((record) => record.port),
    ...read.value.unread.flatMap((record) => portOf(record) ?? [])
  ])
  if (avoid !== undefined) {
    taken.add(avoid)
  }
  const candidates = [
    ...(input.main ? [base] : []),
    ...Array.from({ length: PORT_SPAN }, (_, index) => base + SIM_METRO_WORKTREE_OFFSET + index)
  ].filter((port) => port <= 65535 && !taken.has(port))
  for (const port of candidates) {
    const answer = await plan.probe(port, appDir)
    if (answer === 'foreign' || answer === 'unresponsive') {
      continue
    }
    const record: SimMetroRecord = {
      worktreeRoot: input.worktreeRoot,
      appId: input.appId,
      appDir,
      port,
      assignedAt: plan.now()
    }
    const written = await plan.file.update((value) => {
      const others = value.servers.filter((other) => simMetroKey(other) !== key)
      const raced = value.servers.find((other) => simMetroKey(other) === key)
      if (
        (raced && raced.port !== avoid) ||
        others.some((other) => other.port === port) ||
        value.unread.some((other) => portOf(other) === port)
      ) {
        return null
      }
      return { ...value, servers: [...others, record] }
    })
    if (!written.ok) {
      return written.message
    }
    // Lost a race for the key or the port: the next read decides.
    return written.changed ? record : planSimMetroPort(plan, input, appDir, avoid)
  }
  return `no free Metro port from ${base + SIM_METRO_WORKTREE_OFFSET} to ${base + SIM_METRO_WORKTREE_OFFSET + PORT_SPAN - 1}`
}
