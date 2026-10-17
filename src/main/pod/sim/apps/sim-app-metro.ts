// Fork-only (Pod): one Metro per worktree and app, on the worktree's own port
// (sim-app-metro-ports.ts), told apart from any other Metro by its `/status` (sim-app-metro-http.ts).
// Expo started without a TTY is non-interactive, where a busy `--port` is an error, never a quiet
// move to another port (@expo/cli 58.1.2 utils/port.js choosePortAsync), so the plan stays true. CI
// is left unset: it would turn Metro's file watching off.
//
// Pod starts Metro detached with the recipe's command (`{port}` filled in; an Expo app without one
// gets `./node_modules/.bin/expo start --port {port}`), warms the bundle its dev client will load
// once it is ready, and stops it SIM_METRO_GRACE_MS after the last live lease of its worktree and
// app ends (pre-mortem item 10: an idle Metro holds memory). A Metro Pod did not start (Filip's own
// `pnpm dev`) is used when it serves this app, never stopped.
import { mkdir, realpath, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SimRecipeApp } from '../../../../shared/pod-sim/sim-recipe'
import type { SimRegistryFile } from '../../../../shared/pod-sim/sim-registry'
import type { SimRuntime } from '../pool/sim-pool-ports'
import {
  probeSimMetro,
  warmSimMetroBundle,
  type SimMetroProbe,
  type SimMetroWarm
} from './sim-app-metro-http'
import {
  createSimMetroFile,
  planSimMetroPort,
  simMetroKey,
  type SimMetroRecord
} from './sim-app-metro-ports'
import { stopIdleSimMetros } from './sim-app-metro-idle'
import { simWorktreeTag, type SimAppHome } from './sim-app-paths'
import { simIsMainCheckout } from './sim-app-recipes'
import { simAppEnv } from './sim-app-shell'
import type { SimDetachedSpawn, SimProcessControl } from './sim-app-spawn'

export const SIM_METRO_GRACE_MS = 60_000
/** How long a caller waits for a Metro that is still starting (a cold Expo start is 5 to 20 s). */
export const SIM_METRO_READY_MS = 90_000
/** Someone else is starting it: wait for theirs instead of starting another. */
const STARTING_FRESH_MS = 60_000

export type SimMetroInput = Readonly<{ worktreeRoot: string; appId: string; app: SimRecipeApp }>

export type SimMetroEnsure =
  | Readonly<{
      ok: true
      port: number
      running: boolean
      // Pod started it in this call.
      started: boolean
      // Pod has no command to start it with (not an Expo app, no metro.command).
      command?: string
      logPath: string
    }>
  | Readonly<{ ok: false; message: string }>

export type SimMetroReady =
  | Readonly<{ ok: true; port: number; ms: number }>
  | Readonly<{ ok: false; message: string }>

export type SimMetros = {
  ensure(input: SimMetroInput): Promise<SimMetroEnsure>
  waitReady(input: SimMetroInput, timeoutMs: number): Promise<SimMetroReady>
  /** Once it is ready, has it build the dev client's bundle; null when this Metro process has it. */
  warm(input: SimMetroInput): Promise<SimMetroWarm | null>
  probe(port: number, appDir: string): Promise<SimMetroProbe>
  /** Stops each Metro Pod started whose worktree and app have had no live lease for the grace. */
  reconcile(registry: SimRegistryFile): Promise<string[]>
  logPath(input: Pick<SimMetroInput, 'worktreeRoot' | 'appId'>): string
}

export type SimMetrosOptions = Readonly<{
  home: SimAppHome
  spawn: SimDetachedSpawn
  control: SimProcessControl
  self: SimRuntime
  now?: () => number
  graceMs?: number
  env?: NodeJS.ProcessEnv
}>

export function createSimMetros(options: SimMetrosOptions): SimMetros {
  const { home, control } = options
  const now = options.now ?? Date.now
  const grace = options.graceMs ?? SIM_METRO_GRACE_MS
  const file = createSimMetroFile(home)
  const realDirs = new Map<string, string>()
  // In flight per worktree and app, and the Metro process each last warmed.
  const warming = new Map<string, Promise<SimMetroWarm | null>>()
  const warmed = new Map<string, string>()
  const self = () => ({
    pid: options.self.pid,
    startedAt: options.self.startedAt,
    profile: options.self.profile
  })
  const probe = (port: number, appDir: string) => probeSimMetro(port, appDir)

  const logPath = (input: Pick<SimMetroInput, 'worktreeRoot' | 'appId'>) =>
    join(home.metroLogs, `${simWorktreeTag(input.worktreeRoot)}-${input.appId}.log`)

  /** The folder Metro reports as its project root: the app folder with links resolved. */
  const appDirOf = async (input: SimMetroInput): Promise<string> => {
    const dir = join(input.worktreeRoot, input.app.path)
    const known = realDirs.get(dir)
    if (known) {
      return known
    }
    const real = await realpath(dir).catch(() => dir)
    realDirs.set(dir, real)
    return real
  }

  const plan = async (input: SimMetroInput, appDir: string, avoid?: number) =>
    planSimMetroPort(
      { file, probe, now },
      {
        worktreeRoot: input.worktreeRoot,
        appId: input.appId,
        base: input.app.metro?.port,
        main: await simIsMainCheckout(input.worktreeRoot)
      },
      appDir,
      avoid
    )

  const commandOf = async (
    input: SimMetroInput,
    appDir: string,
    port: number
  ): Promise<string | null> => {
    const command =
      input.app.metro?.command ??
      ((await stat(join(appDir, 'node_modules', '.bin', 'expo')).catch(() => null))
        ? './node_modules/.bin/expo start --port {port}'
        : null)
    return command ? command.replaceAll('{port}', String(port)) : null
  }

  const start = async (
    input: SimMetroInput,
    record: SimMetroRecord,
    command: string
  ): Promise<boolean> => {
    const key = simMetroKey(record)
    const at = now()
    const claimed = await file.update((value) => {
      const current = value.servers.find((other) => simMetroKey(other) === key)
      if (!current || current.port !== record.port) {
        return null
      }
      if (current.starting && at - current.starting.at < STARTING_FRESH_MS) {
        return null
      }
      current.starting = { by: self(), at }
      return value
    })
    if (!claimed.ok || !claimed.changed) {
      return false
    }
    const path = logPath(input)
    await mkdir(home.metroLogs, { recursive: true, mode: 0o700 })
    await writeFile(path, `# Metro for ${record.appDir} on port ${record.port}\n$ ${command}\n`, {
      mode: 0o600
    })
    const spawned = await options.spawn({
      program: '/bin/sh',
      args: ['-c', command],
      cwd: record.appDir,
      env: simAppEnv(input.app.env, options.env),
      logPath: path
    })
    const startedAt = spawned.ok ? await control.startOf(spawned.pid) : null
    await file.update((value) => {
      const current = value.servers.find((other) => simMetroKey(other) === key)
      if (!current) {
        return null
      }
      delete current.starting
      delete current.idleSince
      if (spawned.ok && startedAt !== null) {
        current.process = { pid: spawned.pid, startedAt, since: now(), by: self() }
      }
      return value
    })
    return spawned.ok
  }

  const ensure = async (input: SimMetroInput, tries = 2): Promise<SimMetroEnsure> => {
    const appDir = await appDirOf(input)
    const planned = await plan(input, appDir)
    if (typeof planned === 'string') {
      return { ok: false, message: planned }
    }
    const path = logPath(input)
    const waiting = {
      ok: true,
      port: planned.port,
      running: false,
      started: false,
      logPath: path
    } as const
    const answer = await probe(planned.port, appDir)
    const ours = planned.process ? await control.state(planned.process) : 'exited'
    if (answer === 'ready') {
      return { ...waiting, running: true }
    }
    if (answer === 'starting' || (answer === 'unresponsive' && ours === 'live')) {
      return waiting
    }
    if (answer === 'foreign' || answer === 'unresponsive') {
      if (tries <= 0) {
        return { ok: false, message: `port ${planned.port} answers for another program` }
      }
      const moved = await plan(input, appDir, planned.port)
      return typeof moved === 'string' ? { ok: false, message: moved } : ensure(input, tries - 1)
    }
    // Nothing listens yet: Pod's own process may still be starting up.
    if (ours === 'live') {
      return waiting
    }
    const command = await commandOf(input, appDir, planned.port)
    if (!command) {
      return waiting
    }
    return { ...waiting, started: await start(input, planned, command), command }
  }

  const recordOf = async (input: SimMetroInput): Promise<SimMetroRecord | undefined> => {
    const read = await file.read()
    return read.ok
      ? read.value.servers.find((other) => simMetroKey(other) === simMetroKey(input))
      : undefined
  }

  const waitReady = async (input: SimMetroInput, timeoutMs: number): Promise<SimMetroReady> => {
    const begun = performance.now()
    const appDir = await appDirOf(input)
    for (;;) {
      const record = await recordOf(input)
      if (!record) {
        return { ok: false, message: 'this worktree has no Metro port yet' }
      }
      const answer = await probe(record.port, appDir)
      if (answer === 'ready') {
        return { ok: true, port: record.port, ms: performance.now() - begun }
      }
      if (answer === 'foreign') {
        return { ok: false, message: `port ${record.port} answers for another program` }
      }
      if (answer === 'none' && !record.starting && !record.process) {
        return { ok: false, message: `nothing runs Metro on port ${record.port}` }
      }
      if (
        record.process &&
        answer === 'none' &&
        (await control.state(record.process)) === 'exited'
      ) {
        return {
          ok: false,
          message: `Metro on port ${record.port} exited; its log is ${logPath(input)}`
        }
      }
      if (performance.now() - begun > timeoutMs) {
        return {
          ok: false,
          message: `Metro on port ${record.port} was not ready within ${Math.round(timeoutMs / 1000)} s`
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }

  const warm = (input: SimMetroInput): Promise<SimMetroWarm | null> => {
    const key = simMetroKey(input)
    const known = warming.get(key)
    if (known) {
      return known
    }
    const work = (async (): Promise<SimMetroWarm | null> => {
      const ready = await waitReady(input, SIM_METRO_READY_MS)
      if (!ready.ok) {
        return ready
      }
      // One warm-up per Metro process: a restarted Metro starts cold again.
      const server = (await recordOf(input))?.process
      const identity = `${ready.port}:${server ? `${server.pid}:${server.startedAt}` : 'theirs'}`
      if (warmed.get(key) === identity) {
        return null
      }
      const answer = await warmSimMetroBundle(ready.port)
      if (answer.ok) {
        warmed.set(key, identity)
      }
      return answer
    })().finally(() => warming.delete(key))
    warming.set(key, work)
    return work
  }

  return {
    ensure: (input) => ensure(input),
    waitReady,
    warm,
    probe,
    reconcile: (registry) => stopIdleSimMetros({ file, control, now, graceMs: grace }, registry),
    logPath
  }
}
