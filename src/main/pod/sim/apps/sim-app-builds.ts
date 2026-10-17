// Fork-only (Pod): one dev-client build per native fingerprint per Mac. A cache miss starts a
// build that every later miss for the same bundle id and fingerprint joins, from any worktree and
// any runtime: `clients/builds.json` holds the builds (sim-app-build-records.ts), and a new one is
// written there by compare-and-swap under the flock before its process starts, so of two runtimes
// missing at once one writes it and the other, on its re-read, joins it.
//
// The build runs detached (sim-app-build-process.ts). Whoever sees it end (its own child's exit,
// pushed; else a runtime's `check`, by pid plus start) lands the recipe's output .app in the client
// cache and marks the build done, or failed with its log's last lines. A failed fingerprint does not loop
// (the backoff in sim-app-build-records.ts); a changed fingerprint is a new build.
import { join } from 'node:path'
import type { SimRecipeApp } from '../../../../shared/pod-sim/sim-recipe'
import type { SimRegistryFile } from '../../../../shared/pod-sim/sim-registry'
import type { SimProcessId, SimRuntime } from '../pool/sim-pool-ports'
import { createSimBuildProgress, readSimBuildTail } from './sim-app-build-log'
import { simBuildOutput } from './sim-app-build-output'
import { readSimBuildExit, spawnSimBuildProcess } from './sim-app-build-process'
import {
  createSimBuildsFile,
  endSimBuild,
  pruneSimBuilds,
  SIM_BUILD_FAILURE_LIMIT,
  simBuildId,
  simBuildKey,
  simBuildView,
  type SimBuild,
  type SimBuildRecord
} from './sim-app-build-records'
import type { SimClientCache } from './sim-app-clients'
import type { SimAppHome } from './sim-app-paths'
import { simAppEnv } from './sim-app-shell'
import type { SimDetachedSpawn, SimProcessControl } from './sim-app-spawn'

/** A build written but never started (its runtime died between the write and the spawn). */
const START_STALE_MS = 60_000

export type SimBuildInput = Readonly<{
  appId: string
  app: SimRecipeApp
  fingerprint: string
  worktreeRoot: string
}>

export type SimBuildEnsure =
  | Readonly<{ state: 'building'; build: SimBuildRecord; started: boolean }>
  | Readonly<{ state: 'failed'; build: SimBuildRecord; retryInMinutes: number }>
  | Readonly<{ state: 'done' }>
  | Readonly<{ state: 'unbuildable'; message: string }>

export type SimBuildFinished = Readonly<{ buildId: string; ok: boolean }>

export type SimBuilds = {
  /** Joins this fingerprint's build, starts one, or says why not. */
  ensure(input: SimBuildInput): Promise<SimBuildEnsure>
  /** Ends the builds whose process ended; answers each it ended. */
  check(): Promise<SimBuildFinished[]>
  get(buildId: string): Promise<SimBuildRecord | null>
  /** Every build the file keeps, or null when it cannot be read. */
  all(): Promise<SimBuildRecord[] | null>
  /** The builds for the pool snapshot: in flight and failed, with the leases waiting on each. */
  snapshot(registry: SimRegistryFile | null): Promise<SimBuild[]>
  /** The log's last lines on one line, for a refusal. */
  tail(build: SimBuildRecord): Promise<string | null>
  retryInMinutes(build: SimBuildRecord): number | undefined
}

export type SimBuildsOptions = Readonly<{
  home: SimAppHome
  clients: SimClientCache
  spawn: SimDetachedSpawn
  control: SimProcessControl
  self: SimRuntime
  runtimeState: (ref: SimProcessId) => Promise<'live' | 'exited'>
  // claude-acc's executable: builds go through its scheduler; null runs them directly.
  claudeAcc: string | null
  onFinished?: (finished: SimBuildFinished) => void
  now?: () => number
  random?: () => string
  env?: NodeJS.ProcessEnv
}>

function sameRef(a: SimProcessId, b: SimProcessId): boolean {
  return a.pid === b.pid && a.startedAt === b.startedAt
}

export function createSimBuilds(options: SimBuildsOptions): SimBuilds {
  const { home, clients } = options
  const now = options.now ?? Date.now
  const random = options.random ?? (() => Math.random().toString(36).slice(2, 8))
  const file = createSimBuildsFile(home)
  const progress = createSimBuildProgress()
  const finishing = new Map<string, Promise<SimBuildFinished | null>>()

  /** `running`, `ended` (its exit code is there or its process is gone) or `stale` (never started). */
  const liveness = async (build: SimBuildRecord): Promise<'running' | 'ended' | 'stale'> => {
    if ((await readSimBuildExit(build.statusPath)) !== 'none') {
      return 'ended'
    }
    if (build.process) {
      return (await options.control.state(build.process)) === 'exited' ? 'ended' : 'running'
    }
    const writerGone =
      !sameRef(build.by, options.self) && (await options.runtimeState(build.by)) === 'exited'
    return writerGone || now() - build.startedAt > START_STALE_MS ? 'stale' : 'running'
  }

  const finish = (build: SimBuildRecord): Promise<SimBuildFinished | null> => {
    const already = finishing.get(build.buildId)
    if (already) {
      return already
    }
    const work = (async (): Promise<SimBuildFinished | null> => {
      const code = await readSimBuildExit(build.statusPath)
      let failure: string | null = null
      if (code === 0) {
        const output = await simBuildOutput(build)
        const landed = output.ok
          ? await clients.land(
              output.path,
              build.bundleId,
              build.fingerprint,
              `build:${build.buildId}`
            )
          : output
        failure = landed.ok ? null : landed.message
      } else {
        const tail = (await readSimBuildTail(build.logPath)).slice(-12).join('\n')
        const why =
          code === 'none' || code === null
            ? 'the build process ended without an exit status (stopped or killed)'
            : `the build exited ${code}`
        failure = `${why}${tail ? `\n${tail}` : ''}`
      }
      const { steps } = await progress.advance(build)
      progress.forget(build.buildId)
      const at = now()
      const written = await file.update((value) =>
        endSimBuild(value, build.buildId, { at, steps, failure })
      )
      if (!written.ok || !written.changed) {
        return null
      }
      const finished = { buildId: build.buildId, ok: failure === null }
      options.onFinished?.(finished)
      return finished
    })().finally(() => finishing.delete(build.buildId))
    finishing.set(build.buildId, work)
    return work
  }

  const spawnBuild = async (build: SimBuildRecord, app: SimRecipeApp): Promise<void> => {
    const spawned = await spawnSimBuildProcess(build, {
      logDir: home.buildLogs,
      claudeAcc: options.claudeAcc,
      env: simAppEnv(app.env, options.env),
      spawn: options.spawn,
      onExit: () => {
        void finish(build).catch(() => undefined)
      }
    })
    const startedAt = spawned.ok ? await options.control.startOf(spawned.pid) : null
    await file.update((value) => {
      const current = value.builds.find((other) => other.buildId === build.buildId)
      if (current?.state !== 'building') {
        return null
      }
      if (spawned.ok && startedAt !== null) {
        current.process = { pid: spawned.pid, startedAt }
      } else {
        current.state = 'failed'
        current.endedAt = now()
        current.failures += 1
        current.failure = {
          message: spawned.ok ? 'the build process ended at once' : spawned.message.slice(0, 1024)
        }
      }
      return value
    })
  }

  const retryIn = (build: SimBuildRecord): number | undefined =>
    build.retryAt && build.retryAt > now() ? Math.ceil((build.retryAt - now()) / 60_000) : undefined

  const ensure = async (input: SimBuildInput): Promise<SimBuildEnsure> => {
    const { app } = input
    if (!app.build) {
      return {
        state: 'unbuildable',
        message: `simulators.apps.${input.appId}.build is not set, and no cached client has fingerprint ${input.fingerprint}`
      }
    }
    const key = simBuildKey({ bundleId: app.bundleId, fingerprint: input.fingerprint })
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const read = await file.read()
      if (!read.ok) {
        return { state: 'unbuildable', message: read.message }
      }
      const current = read.value.builds.findLast((other) => simBuildKey(other) === key)
      let failures = 0
      if (current?.state === 'building') {
        const state = await liveness(current)
        if (state === 'running') {
          return { state: 'building', build: current, started: false }
        }
        if (state === 'ended') {
          await finish(current)
          continue
        }
        failures = current.failures
      } else if (current?.state === 'failed') {
        const wait = retryIn(current)
        if (current.failures >= SIM_BUILD_FAILURE_LIMIT && wait !== undefined) {
          return { state: 'failed', build: current, retryInMinutes: wait }
        }
        failures = current.failures
      } else if (
        current?.state === 'done' &&
        (await clients.find(app.bundleId, input.fingerprint))
      ) {
        return { state: 'done' }
      }
      const buildId = simBuildId(input.appId, input.fingerprint, random())
      const record: SimBuildRecord = {
        buildId,
        appId: input.appId,
        bundleId: app.bundleId,
        fingerprint: input.fingerprint,
        worktreeRoot: input.worktreeRoot,
        appDir: join(input.worktreeRoot, app.path),
        output: app.build.output,
        command: app.build.command,
        state: 'building',
        startedAt: now(),
        by: {
          pid: options.self.pid,
          startedAt: options.self.startedAt,
          profile: options.self.profile
        },
        logPath: join(home.buildLogs, `${buildId}.log`),
        statusPath: join(home.buildLogs, `${buildId}.status`),
        failures
      }
      const written = await file.update((value) => {
        const latest = value.builds.findLast((other) => simBuildKey(other) === key)
        // Someone else wrote a build of this fingerprint since our read: join it instead.
        if (latest && latest.buildId !== current?.buildId) {
          return null
        }
        const pruned = pruneSimBuilds(value, record.startedAt)
        pruned.builds = [...pruned.builds.filter((other) => simBuildKey(other) !== key), record]
        return pruned
      })
      if (!written.ok) {
        return { state: 'unbuildable', message: written.message }
      }
      if (!written.changed) {
        continue
      }
      await spawnBuild(record, app)
      const reread = await file.read()
      const after = reread.ok
        ? reread.value.builds.find((other) => other.buildId === buildId)
        : null
      return after?.state === 'failed'
        ? { state: 'failed', build: after, retryInMinutes: retryIn(after) ?? 0 }
        : { state: 'building', build: after ?? record, started: true }
    }
    return { state: 'unbuildable', message: `${home.builds} kept changing; try again` }
  }

  return {
    ensure,

    async check() {
      const read = await file.read()
      const ended: SimBuildFinished[] = []
      for (const build of read.ok ? read.value.builds : []) {
        if (build.state === 'building' && (await liveness(build)) === 'ended') {
          const finished = await finish(build)
          if (finished) {
            ended.push(finished)
          }
        }
      }
      return ended
    },

    async get(buildId) {
      const read = await file.read()
      return read.ok ? (read.value.builds.find((build) => build.buildId === buildId) ?? null) : null
    },

    async all() {
      const read = await file.read()
      return read.ok ? read.value.builds : null
    },

    async snapshot(registry) {
      const read = await file.read()
      const out: SimBuild[] = []
      for (const build of read.ok ? read.value.builds : []) {
        if (build.state === 'done') {
          continue
        }
        const waiting = (registry?.leases ?? [])
          .filter((lease) => lease.queue?.buildId === build.buildId)
          .map((lease) => lease.leaseId)
        const seen = build.state === 'building' ? await progress.advance(build) : null
        const lastSteps = read.ok ? read.value.history?.[build.bundleId]?.steps : undefined
        out.push(simBuildView(build, waiting, seen, lastSteps))
      }
      return out
    },

    async tail(build) {
      const last = (await readSimBuildTail(build.logPath)).slice(-3).join(' | ')
      return last ? last.slice(-600) : null
    },

    retryInMinutes: retryIn
  }
}
