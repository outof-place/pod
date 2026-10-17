// Fork-only (Pod): one dev-client build per native fingerprint per Mac. A cache miss starts a
// build that every later miss for the same bundle id and fingerprint joins, from any worktree and
// any runtime: `clients/builds.json` holds the builds (sim-app-build-records.ts), and a new one is
// written there by compare-and-swap under the flock before its process starts, so of two runtimes
// missing at once one writes it and the other, on its re-read, joins it.
//
// The build runs detached (sim-app-build-process.ts); how it ends, and the stop of one that runs
// past its limit, is sim-app-build-end.ts. A failed fingerprint does not loop (the backoff in
// sim-app-build-records.ts); a changed fingerprint is a new build. While `ps` cannot say whether a
// build runs, it runs.
import { join } from 'node:path'
import type { SimRecipeApp } from '../../../../shared/pod-sim/sim-recipe'
import type { SimRegistryFile } from '../../../../shared/pod-sim/sim-registry'
import type { SimProcessId, SimRuntime } from '../pool/sim-pool-ports'
import { readSimBuildTail } from './sim-app-build-log'
import { createSimBuildEnder, type SimBuildFinished } from './sim-app-build-end'
import { readSimBuildExit, spawnSimBuildProcess } from './sim-app-build-process'
import {
  createSimBuildsFile,
  pruneSimBuilds,
  SIM_BUILD_FAILURE_LIMIT,
  simBuildId,
  simBuildKey,
  simBuildLimitMs,
  simBuildProcess,
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
  // Asked once, only before a new build would start: null to build, else why not.
  confirm?: () => Promise<string | null>
}>

export type SimBuildEnsure =
  | Readonly<{ state: 'building'; build: SimBuildRecord; started: boolean }>
  | Readonly<{ state: 'failed'; build: SimBuildRecord; retryInMinutes: number }>
  | Readonly<{ state: 'done' }>
  | Readonly<{ state: 'unbuildable'; message: string }>

export type { SimBuildFinished } from './sim-app-build-end'

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
  const ender = createSimBuildEnder({
    file,
    clients,
    control: options.control,
    now,
    ...(options.onFinished ? { onFinished: options.onFinished } : {})
  })
  const { finish, progress } = ender

  /** `running`, `ended` (its exit code is there or its process is gone) or `stale` (never started). */
  const liveness = async (build: SimBuildRecord): Promise<'running' | 'ended' | 'stale'> => {
    if ((await readSimBuildExit(build.statusPath)) !== 'none') {
      return 'ended'
    }
    const ref = simBuildProcess(build)
    if (ref) {
      // Unknown (a busy Mac) runs on: only a process seen gone has ended.
      return (await options.control.state(ref)) === 'exited' ? 'ended' : 'running'
    }
    const writerGone =
      !sameRef(build.by, options.self) && (await options.runtimeState(build.by)) === 'exited'
    return writerGone || now() - build.startedAt > START_STALE_MS ? 'stale' : 'running'
  }

  const spawnBuild = async (build: SimBuildRecord, app: SimRecipeApp): Promise<void> => {
    const spawnedAt = Date.now()
    const spawned = await spawnSimBuildProcess(build, {
      logDir: home.buildLogs,
      claudeAcc: options.claudeAcc,
      env: simAppEnv(app.env, options.env),
      spawn: options.spawn,
      onExit: () => {
        void finish(build).catch(() => undefined)
      }
    })
    // Unknown (ps did not answer) or gone (it ended at once): its pid is still its record, and its
    // status file or a later check says how it ended.
    const start = spawned.ok ? await options.control.startOf(spawned.pid) : 'gone'
    await file.update((value) => {
      const current = value.builds.find((other) => other.buildId === build.buildId)
      if (current?.state !== 'building') {
        return null
      }
      if (spawned.ok) {
        current.process = {
          pid: spawned.pid,
          spawnedAt,
          ...(typeof start === 'number' ? { startedAt: start } : {})
        }
      } else {
        current.state = 'failed'
        current.endedAt = now()
        current.failures += 1
        current.failure = { message: spawned.message.slice(0, 1024) }
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
    let confirmed = false
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
      if (!confirmed && input.confirm) {
        const refused = await input.confirm()
        if (refused) {
          return { state: 'unbuildable', message: refused }
        }
        confirmed = true
        continue
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
        if (build.state !== 'building') {
          continue
        }
        const state = await liveness(build)
        const finished =
          state === 'ended'
            ? await finish(build)
            : state === 'running' && read.ok
              ? await ender.stopIfOverdue(build, simBuildLimitMs(read.value, build.bundleId))
              : null
        if (finished) {
          ended.push(finished)
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
