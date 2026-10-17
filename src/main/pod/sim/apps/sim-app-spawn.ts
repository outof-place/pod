// Fork-only (Pod): processes the app module starts that outlive the call and the runtime: a
// worktree's Metro and a dev-client build. Each runs detached (its own session and process group,
// so a runtime restart leaves it running and a stop reaches its whole tree), with its output
// appended to a log file and no pipe back to the runtime. The registry files record its pid and
// start, so any runtime can find it again, check it is the same process and stop it.
import { spawnProcess } from '@orca/process-host'
import { mkdir, open } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { SimProcessFacts } from '../adapters/sim-process-facts'

export type SimDetachedSpec = Readonly<{
  program: string
  args: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  logPath: string
  // Only while this runtime lives: its own child's exit, pushed. Other runtimes find out by pid.
  onExit?: (code: number | null) => void
}>

export type SimSpawned =
  | Readonly<{ ok: true; pid: number }>
  | Readonly<{ ok: false; message: string }>

export type SimDetachedSpawn = (spec: SimDetachedSpec) => Promise<SimSpawned>

export const simSpawnDetached: SimDetachedSpawn = async (spec) => {
  await mkdir(dirname(spec.logPath), { recursive: true, mode: 0o700 })
  const log = await open(spec.logPath, 'a', 0o600)
  try {
    const child = spawnProcess({
      program: spec.program,
      args: spec.args,
      cwd: spec.cwd,
      env: spec.env,
      detached: true,
      stdio: ['ignore', log.fd, log.fd]
    })
    // Listened for before any await: bun can emit a quick child's exit before the spawn wait ends.
    child.once('exit', (code) => {
      if (child.pid) {
        spec.onExit?.(code)
      }
    })
    const pid = await new Promise<number>((resolve, reject) => {
      child.once('spawn', () => resolve(child.pid ?? 0))
      child.once('error', reject)
    })
    child.unref()
    return pid > 0
      ? { ok: true, pid }
      : { ok: false, message: `${spec.program} started without a pid` }
  } catch (error) {
    return { ok: false, message: `${spec.program}: ${String(error)}` }
  } finally {
    await log.close()
  }
}

/**
 * A process the app module spawned, as its record keeps it: the kernel's start when `ps` read it,
 * and the wall time it was spawned at, which stands in while `ps` could not answer (a busy Mac).
 */
export type SimSpawnedRef = Readonly<{ pid: number; startedAt?: number; spawnedAt: number }>

export type SimProcessControl = Readonly<{
  // `live` only when the pid runs and started when the record says (within 2 s, as claude-acc),
  // or, its start never read, within a minute of its spawn; `unknown` while `ps` cannot answer.
  state(ref: SimSpawnedRef): Promise<'live' | 'exited' | 'unknown'>
  // SIGTERM to its process group, SIGKILL after `graceMs` if it still runs; `unknown` signals nothing.
  stop(ref: SimSpawnedRef, graceMs?: number): Promise<'stopped' | 'exited' | 'unknown'>
  // Its kernel start; `gone` when no such process runs, `unknown` when `ps` did not answer.
  startOf(pid: number): Promise<number | 'gone' | 'unknown'>
}>

const START_SLACK_S = 2
// A spawn's 'spawn' event to the kernel's start of the process: seconds at worst, on a busy Mac.
const SPAWN_WINDOW_S = 60

export function createSimProcessControl(processes: SimProcessFacts): SimProcessControl {
  const state = async (ref: SimSpawnedRef): Promise<'live' | 'exited' | 'unknown'> => {
    const start = await processes.startOf(ref.pid)
    if (start === 'unknown') {
      return 'unknown'
    }
    if (!start.found) {
      return 'exited'
    }
    if (ref.startedAt !== undefined) {
      return Math.abs(start.startedAt - ref.startedAt) <= START_SLACK_S ? 'live' : 'exited'
    }
    // Its start was never read: a process of this pid started near its spawn is it (pids do not
    // come round again within a minute).
    const spawned = ref.spawnedAt / 1000
    return start.startedAt >= Math.floor(spawned) - START_SLACK_S &&
      start.startedAt <= spawned + SPAWN_WINDOW_S
      ? 'live'
      : 'exited'
  }
  const signal = (pid: number, name: NodeJS.Signals) => {
    try {
      process.kill(-pid, name)
    } catch {
      try {
        process.kill(pid, name)
      } catch {
        // Gone already.
      }
    }
  }
  return {
    state,
    async stop(ref, graceMs = 3_000) {
      const now = await state(ref)
      if (now !== 'live') {
        return now
      }
      signal(ref.pid, 'SIGTERM')
      // The pid was this process a moment ago; signal 0 answers without a ps per check.
      const runs = () => {
        try {
          process.kill(ref.pid, 0)
          return true
        } catch {
          return false
        }
      }
      const deadline = performance.now() + graceMs
      while (performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        if (!runs()) {
          return 'stopped'
        }
      }
      signal(ref.pid, 'SIGKILL')
      return 'stopped'
    },
    async startOf(pid) {
      const start = await processes.startOf(pid)
      if (start === 'unknown') {
        return 'unknown'
      }
      return start.found ? start.startedAt : 'gone'
    }
  }
}
