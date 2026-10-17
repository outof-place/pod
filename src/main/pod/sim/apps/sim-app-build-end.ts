// Fork-only (Pod): how a dev-client build ends. Whoever sees it end (its own child's exit, pushed;
// else a runtime's check) lands the recipe's output .app in the client cache and marks the build
// done, failed with its log's last lines, or stopped when something else stopped it (claude-acc's
// cancel or memory brake, sim-app-build-log.ts), which counts toward no backoff. A build that runs
// past its limit (3x its app's last good build, else an hour) is marked `stopping`, its log says
// why, its process group is stopped, and it fails: a hung build is a broken one. One that
// claude-acc still holds in its queue is not running yet, and while `ps` cannot answer nothing is
// stopped.
import { appendFile } from 'node:fs/promises'
import { createSimBuildProgress, readSimBuildTail, simBuildStopReason } from './sim-app-build-log'
import { simBuildOutput } from './sim-app-build-output'
import { readSimBuildExit } from './sim-app-build-process'
import {
  endSimBuild,
  SIM_BUILD_DEFAULT_LIMIT_MS,
  SIM_BUILD_WAITING_FOR_MEMORY,
  simBuildProcess,
  type SimBuildEnd,
  type SimBuildRecord,
  type SimBuildsFile
} from './sim-app-build-records'
import type { SimClientCache } from './sim-app-clients'
import type { SimJsonFile } from './sim-app-json-file'
import type { SimProcessControl } from './sim-app-spawn'

export type SimBuildFinished = Readonly<{ buildId: string; ok: boolean }>

export type SimBuildEnder = {
  /** Ends a build whose process ended; null when another call or runtime ended it first. */
  finish(build: SimBuildRecord): Promise<SimBuildFinished | null>
  /** Stops a running build past `limitMs`; answers like `finish` once its process is gone. */
  stopIfOverdue(build: SimBuildRecord, limitMs: number): Promise<SimBuildFinished | null>
  /** The build's progress from its log, read on from where the last call stopped. */
  progress: ReturnType<typeof createSimBuildProgress>
}

export function createSimBuildEnder(
  options: Readonly<{
    file: SimJsonFile<SimBuildsFile>
    clients: SimClientCache
    control: SimProcessControl
    now: () => number
    onFinished?: (finished: SimBuildFinished) => void
  }>
): SimBuildEnder {
  const { file, clients, now } = options
  const progress = createSimBuildProgress()
  const finishing = new Map<string, Promise<SimBuildFinished | null>>()

  /** How it ended: its exit code and log, or the reason Pod stopped it (`stopping`). */
  const outcomeOf = async (build: SimBuildRecord): Promise<SimBuildEnd> => {
    const code = await readSimBuildExit(build.statusPath)
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
      return landed.ok ? { kind: 'done' } : { kind: 'failed', message: landed.message }
    }
    const lines = await readSimBuildTail(build.logPath)
    const tail = lines.slice(-12).join('\n')
    const read = await file.read()
    const stopping = read.ok
      ? read.value.builds.find((other) => other.buildId === build.buildId)?.stopping
      : undefined
    if (stopping) {
      return { kind: 'failed', message: `${stopping.message}${tail ? `\n${tail}` : ''}` }
    }
    const why =
      code === 'none' || code === null
        ? 'the build process ended without an exit status (stopped or killed)'
        : `the build exited ${code}`
    const message = `${why}${tail ? `\n${tail}` : ''}`
    const stopped = simBuildStopReason(code, lines)
    return stopped ? { kind: 'stopped', why: stopped, message } : { kind: 'failed', message }
  }

  const finish = (build: SimBuildRecord): Promise<SimBuildFinished | null> => {
    const already = finishing.get(build.buildId)
    if (already) {
      return already
    }
    const work = (async (): Promise<SimBuildFinished | null> => {
      const outcome = await outcomeOf(build)
      const { steps } = await progress.advance(build)
      progress.forget(build.buildId)
      const at = now()
      const written = await file.update((value) =>
        endSimBuild(value, build.buildId, { at, steps, outcome })
      )
      if (!written.ok || !written.changed) {
        return null
      }
      const finished = { buildId: build.buildId, ok: outcome.kind === 'done' }
      options.onFinished?.(finished)
      return finished
    })().finally(() => finishing.delete(build.buildId))
    finishing.set(build.buildId, work)
    return work
  }

  /** Why it is overdue, or null: within its limit, or held in claude-acc's queue. */
  const overdue = async (build: SimBuildRecord, limitMs: number): Promise<string | null> => {
    if (build.stopping) {
      return build.stopping.message
    }
    if (now() - build.startedAt <= limitMs) {
      return null
    }
    const seen = await progress.advance(build)
    // Its time in claude-acc's queue is not build time.
    if (
      seen.phase === SIM_BUILD_WAITING_FOR_MEMORY ||
      now() - build.startedAt - (seen.queuedMs ?? 0) <= limitMs
    ) {
      return null
    }
    const limit =
      limitMs < 60_000 ? `${Math.round(limitMs / 1000)} s` : `${Math.round(limitMs / 60_000)} min`
    return limitMs === SIM_BUILD_DEFAULT_LIMIT_MS
      ? `it ran past ${limit} (no good build of this app to go by)`
      : `it ran past ${limit} (3x the last good build)`
  }

  return {
    finish,
    progress,

    async stopIfOverdue(build, limitMs) {
      const message = await overdue(build, limitMs)
      if (!message) {
        return null
      }
      if (!build.stopping) {
        const marked = await file.update((value) => {
          const current = value.builds.find((other) => other.buildId === build.buildId)
          if (current?.state !== 'building' || current.stopping) {
            return null
          }
          current.stopping = { at: now(), message }
          return value
        })
        if (!marked.ok || !marked.changed) {
          return null
        }
        await appendFile(build.logPath, `\nPod stopped this build: ${message}.\n`).catch(
          () => undefined
        )
      }
      const ref = simBuildProcess(build)
      // Unknown: `ps` did not answer; the next check tries again.
      if (!ref || (await options.control.stop(ref, 5_000)) === 'unknown') {
        return null
      }
      return finish(build)
    }
  }
}
