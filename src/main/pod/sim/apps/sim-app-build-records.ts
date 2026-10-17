// Fork-only (Pod): `clients/builds.json`, the Mac-wide record of dev-client builds (in flight,
// failed, done), its rules for how long each is kept, and the failure backoff. Like the pool's make
// failures (sim-pool-make-failures.ts): past SIM_BUILD_FAILURE_LIMIT failures in a row of one
// bundle id and fingerprint, it is not built again until a backoff passes, doubling up to a cap. A
// build costs minutes of a 10 GB process, so the first failure allows one retry (a flake, a fix
// outside the native code), the second stops it.
import { z } from 'zod'
import type { SimBuild as SimBuildSchema } from '../../../../shared/pod-sim/sim-pool-snapshot'
import { SimRuntimeRef } from '../../../../shared/pod-sim/sim-registry'
import { createSimJsonFile, type SimJsonFile } from './sim-app-json-file'
import type { SimAppHome } from './sim-app-paths'

export const SIM_BUILD_FAILURE_LIMIT = 2
export const SIM_BUILD_BACKOFF_MS = 10 * 60_000
export const SIM_BUILD_BACKOFF_MAX_MS = 2 * 60 * 60_000
const DONE_KEPT_MS = 60 * 60_000
const FAILED_KEPT_MS = 24 * 60 * 60_000

const ProcessRef = z.looseObject({
  pid: z.number().int().positive(),
  startedAt: z.number().int().nonnegative()
})

const SimBuildRecord = z.looseObject({
  buildId: z.string().regex(/^sb_[0-9a-z_-]{1,96}$/),
  appId: z.string().min(1).max(64),
  bundleId: z.string().min(1).max(256),
  fingerprint: z.string().min(1).max(256),
  worktreeRoot: z.string().min(1),
  appDir: z.string().min(1),
  // Where the recipe's build leaves the .app, relative to appDir (may hold `*`).
  output: z.string().min(1),
  command: z.string().min(1),
  state: z.enum(['building', 'done', 'failed']),
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative().optional(),
  // The runtime that wrote it; `process` once the build's wrapper runs.
  by: SimRuntimeRef,
  process: ProcessRef.optional(),
  logPath: z.string().min(1),
  statusPath: z.string().min(1),
  // Why it failed: its log's last lines.
  failure: z.looseObject({ message: z.string().max(1024) }).optional(),
  // Failures in a row of this bundle id and fingerprint, this one included when it failed.
  failures: z.number().int().nonnegative(),
  retryAt: z.number().int().nonnegative().optional()
})
export type SimBuildRecord = z.infer<typeof SimBuildRecord>

const SimBuildsFile = z.looseObject({
  version: z.literal(1),
  builds: z.array(SimBuildRecord),
  // The last good build's step count and length per bundle id: the next one's progress.
  history: z
    .record(z.string(), z.looseObject({ steps: z.number().int().nonnegative(), ms: z.number() }))
    .optional()
})
export type SimBuildsFile = z.infer<typeof SimBuildsFile>

/** A build as the pool snapshot and a waiting lease show it. */
export type SimBuild = z.infer<typeof SimBuildSchema>

export function createSimBuildsFile(home: SimAppHome): SimJsonFile<SimBuildsFile> {
  return createSimJsonFile<SimBuildsFile>({
    path: home.builds,
    lock: home.buildsLock,
    parse: (json) => {
      const parsed = SimBuildsFile.safeParse(json)
      return parsed.success ? parsed.data : null
    },
    empty: () => ({ version: 1, builds: [] })
  })
}

export function simBuildKey(build: Readonly<{ bundleId: string; fingerprint: string }>): string {
  return `${build.bundleId}\u0000${build.fingerprint}`
}

/** `sb_<app>_<fingerprint head>_<random>`, within the contract's SimBuildId. */
export function simBuildId(appId: string, fingerprint: string, random: string): string {
  const app = appId
    .toLowerCase()
    .replace(/[^0-9a-z-]/g, '-')
    .slice(0, 40)
  const fp = fingerprint
    .toLowerCase()
    .replace(/[^0-9a-z]/g, '')
    .slice(0, 10)
  return `sb_${app}_${fp}_${random.replace(/[^0-9a-z]/g, '').slice(0, 8) || '0'}`
}

export function simBuildBackoffMs(failures: number): number {
  const doublings = Math.max(0, failures - SIM_BUILD_FAILURE_LIMIT)
  return Math.min(SIM_BUILD_BACKOFF_MS * 2 ** doublings, SIM_BUILD_BACKOFF_MAX_MS)
}

/** Builds in flight, done builds for an hour, failed ones for a day or while their backoff runs. */
export function pruneSimBuilds(value: SimBuildsFile, at: number): SimBuildsFile {
  return {
    ...value,
    builds: value.builds.filter(
      (build) =>
        build.state === 'building' ||
        (build.state === 'done' && at - (build.endedAt ?? at) < DONE_KEPT_MS) ||
        (build.state === 'failed' &&
          (at - (build.endedAt ?? at) < FAILED_KEPT_MS || (build.retryAt ?? 0) > at))
    )
  }
}

/** The file with a build in flight marked done or failed (null when it is not in flight). */
export function endSimBuild(
  value: SimBuildsFile,
  buildId: string,
  end: Readonly<{ at: number; steps: number; failure: string | null }>
): SimBuildsFile | null {
  const current = value.builds.find((other) => other.buildId === buildId)
  if (current?.state !== 'building') {
    return null
  }
  current.state = end.failure === null ? 'done' : 'failed'
  current.endedAt = end.at
  if (end.failure === null) {
    current.failures = 0
    delete current.failure
    delete current.retryAt
    value.history = {
      ...value.history,
      [current.bundleId]: { steps: end.steps, ms: end.at - current.startedAt }
    }
  } else {
    current.failures += 1
    current.failure = { message: end.failure.slice(-1024) }
    if (current.failures >= SIM_BUILD_FAILURE_LIMIT) {
      current.retryAt = end.at + simBuildBackoffMs(current.failures)
    }
  }
  return value
}

export const SIM_BUILD_WAITING_FOR_MEMORY = 'waiting for memory (claude-acc)'

/** The snapshot's view of a build in flight or failed. */
export function simBuildView(
  build: SimBuildRecord,
  waiting: string[],
  seen: Readonly<{ steps: number; phase?: string }> | null,
  lastSteps: number | undefined
): SimBuild {
  const queued = seen?.phase === SIM_BUILD_WAITING_FOR_MEMORY
  return {
    buildId: build.buildId,
    appId: build.appId,
    bundleId: build.bundleId,
    fingerprint: build.fingerprint,
    state: build.state === 'failed' ? 'failed' : queued ? 'queued' : 'building',
    startedAt: build.startedAt,
    ...(seen && lastSteps ? { progress: Math.min(0.95, seen.steps / lastSteps) } : {}),
    ...(seen?.phase ? { phase: seen.phase } : {}),
    waiting,
    logPath: build.logPath,
    ...(build.failure ? { failure: { message: build.failure.message.slice(-1024) } } : {})
  }
}
