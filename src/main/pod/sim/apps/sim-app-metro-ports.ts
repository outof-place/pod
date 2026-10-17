// Fork-only (Pod): which port each worktree's Metro runs on. `metro.json` in the simulator home
// keeps the plan Mac-wide (compare-and-swap under its flock, like the registry), so the port stays
// the worktree's across calls and runtime restarts and differs between worktrees: a repo's main
// checkout gets the recipe's port, every other worktree the lowest port from the recipe's port plus
// SIM_METRO_WORKTREE_OFFSET that no other worktree holds and nothing else listens on. A port another
// program has taken since is given up for the next free one.
import { z } from 'zod'
import { SimRuntimeRef } from '../../../../shared/pod-sim/sim-registry'
import { createSimJsonFile, type SimJsonFile } from './sim-app-json-file'
import type { SimMetroProbe } from './sim-app-metro-http'
import type { SimAppHome } from './sim-app-paths'

/** Worktrees other than the main checkout start this far above the recipe's port. */
export const SIM_METRO_WORKTREE_OFFSET = 100
const PORT_SPAN = 900
/** A recipe's Metro without a port: React Native's own default. */
const DEFAULT_PORT = 8081

const SimMetroRecord = z.looseObject({
  worktreeRoot: z.string().min(1),
  appId: z.string().min(1).max(64),
  appDir: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  assignedAt: z.number().int().nonnegative(),
  // The Metro Pod started for it (a Metro Pod did not start has none).
  process: z
    .looseObject({
      pid: z.number().int().positive(),
      startedAt: z.number().int().nonnegative(),
      since: z.number().int().nonnegative(),
      by: SimRuntimeRef
    })
    .optional(),
  starting: z.looseObject({ by: SimRuntimeRef, at: z.number().int().nonnegative() }).optional(),
  // When the last live lease of this worktree and app was seen gone.
  idleSince: z.number().int().nonnegative().optional()
})
export type SimMetroRecord = z.infer<typeof SimMetroRecord>

const SimMetroFile = z.looseObject({ version: z.literal(1), servers: z.array(SimMetroRecord) })
export type SimMetroFile = z.infer<typeof SimMetroFile>

export function createSimMetroFile(home: SimAppHome): SimJsonFile<SimMetroFile> {
  return createSimJsonFile<SimMetroFile>({
    path: home.metro,
    lock: home.metroLock,
    parse: (json) => {
      const parsed = SimMetroFile.safeParse(json)
      return parsed.success ? parsed.data : null
    },
    empty: () => ({ version: 1, servers: [] })
  })
}

export function simMetroKey(record: Readonly<{ worktreeRoot: string; appId: string }>): string {
  return `${record.worktreeRoot}\u0000${record.appId}`
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
  const taken = new Set(
    read.value.servers.filter((record) => simMetroKey(record) !== key).map((record) => record.port)
  )
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
      if ((raced && raced.port !== avoid) || others.some((other) => other.port === port)) {
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
