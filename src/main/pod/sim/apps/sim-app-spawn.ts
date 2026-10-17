// Fork-only (Pod): processes the app module starts that outlive the call and the runtime: a
// worktree's Metro and a dev-client build. Each runs detached (its own session and process group,
// so a runtime restart leaves it running and a stop reaches its whole tree), with its output
// appended to a log file and no pipe back to the runtime. The registry files record its pid and
// start, so any runtime can find it again, check it is the same process and stop it.
import { spawnProcess } from '@orca/process-host'
import { mkdir, open } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { SimProcessFacts } from '../adapters/sim-process-facts'
import type { SimProcessId } from '../pool/sim-pool-ports'

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
    const pid = await new Promise<number>((resolve, reject) => {
      child.once('spawn', () => resolve(child.pid ?? 0))
      child.once('error', reject)
    })
    child.once('exit', (code) => spec.onExit?.(code))
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

export type SimProcessControl = Readonly<{
  // `live` only when the pid runs and started when the record says (within 2 s, as claude-acc).
  state(ref: SimProcessId): Promise<'live' | 'exited' | 'unknown'>
  // SIGTERM to its process group, SIGKILL after `graceMs` if it still runs.
  stop(ref: SimProcessId, graceMs?: number): Promise<void>
  startOf(pid: number): Promise<number | null>
}>

const START_SLACK_S = 2

export function createSimProcessControl(processes: SimProcessFacts): SimProcessControl {
  const state = async (ref: SimProcessId): Promise<'live' | 'exited' | 'unknown'> => {
    const start = await processes.startOf(ref.pid)
    if (start === 'unknown') {
      return 'unknown'
    }
    return start.found && Math.abs(start.startedAt - ref.startedAt) <= START_SLACK_S
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
      if ((await state(ref)) !== 'live') {
        return
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
          return
        }
      }
      signal(ref.pid, 'SIGKILL')
    },
    async startOf(pid) {
      const start = await processes.startOf(pid)
      return start !== 'unknown' && start.found ? start.startedAt : null
    }
  }
}
