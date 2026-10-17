// Fork-only (Pod): one Metro per worktree and app, on the worktree's own port
// (sim-app-metro-ports.ts), told apart from any other Metro by its `/status` (sim-app-metro-http.ts).
// Expo started without a TTY is non-interactive, where a busy `--port` is an error, never a quiet
// move to another port (@expo/cli 58.1.2 utils/port.js choosePortAsync), so the plan stays true. CI
// is left unset: it would turn Metro's file watching off.
//
// Pod starts Metro detached with the recipe's command (`{port}` filled in; an Expo app without one
// gets `./node_modules/.bin/expo start --port {port}`) for a lease that uses it now or next
// (sim-app-metro-idle.ts), warms the bundle its dev client will load once it is ready, and stops it
// SIM_METRO_GRACE_MS after the last such lease of its worktree and app ends (pre-mortem item 10: an
// idle Metro holds memory). A Metro Pod did not start (Filip's own `pnpm dev`) is used when it
// serves this app, never stopped. A port moves only for another program that answers on it: a busy
// one (no answer within the probe) keeps it, and so does Pod's own Metro while `ps` cannot say.
import { mkdir, realpath, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SimRecipeApp } from '../../../../shared/pod-sim/sim-recipe'
import { SIM_POOL_DEFAULTS } from '../pool/sim-pool-config'
import type { SimRuntime } from '../pool/sim-pool-ports'
import {
  probeSimMetro,
  warmSimMetroBundle,
  type SimMetroProbe,
  type SimMetroWarm
} from './sim-app-metro-http'
import { stopIdleSimMetros } from './sim-app-metro-idle'
import {
  createSimMetroFile,
  planSimMetroPort,
  SIM_METRO_STARTING_FRESH_MS,
  simMetroKey,
  simMetroProcess,
  simMetroUnstarted,
  type SimMetroRecord
} from './sim-app-metro-ports'
import { simWorktreeTag, type SimAppHome } from './sim-app-paths'
import { simIsMainCheckout } from './sim-app-recipes'
import { simAppEnv } from './sim-app-shell'
import type { SimDetachedSpawn, SimProcessControl } from './sim-app-spawn'

/** The pool's warm window: the next lease of the worktree finds its Metro as it finds its device. */
export const SIM_METRO_GRACE_MS = SIM_POOL_DEFAULTS.warmMs
/** How long a caller waits for a Metro that is still starting (a cold Expo start is 5 to 20 s). */
export const SIM_METRO_READY_MS = 90_000

export type SimMetroInput = Readonly<{ worktreeRoot: string; appId: string; app: SimRecipeApp }>

export type SimMetroEnsure =
  | Readonly<{
      ok: true
      port: number
      running: boolean
      // Pod started it in this call.
      started: boolean
      // The Metro on this port is one Pod started (and stops once idle).
      ours: boolean
      // The command Pod started it with.
      command?: string
      logPath: string
    }>
  | Readonly<{ ok: false; message: string }>

/** `start: false` plans the port and says what runs there, starting nothing. */
export type SimMetroEnsureHow = Readonly<{ start: boolean }>

export type SimMetroReady =
  | Readonly<{ ok: true; port: number; ms: number }>
  | Readonly<{ ok: false; message: string }>

export type SimMetros = {
  ensure(input: SimMetroInput, how: SimMetroEnsureHow): Promise<SimMetroEnsure>
  waitReady(input: SimMetroInput, timeoutMs: number): Promise<SimMetroReady>
  /** Once it is ready, has it build the dev client's bundle; null when this Metro process has it. */
  warm(input: SimMetroInput): Promise<SimMetroWarm | null>
  probe(port: number, appDir: string): Promise<SimMetroProbe>
  /** Stops each Metro Pod started whose worktree and app (by key) have been out of use for the grace. */
  reconcile(inUse: ReadonlySet<string>): Promise<string[]>
  /** The keys among these with no Metro process of Pod's recorded and none starting. */
  unstarted(keys: Iterable<string>): Promise<string[]>
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
      if (current.starting && at - current.starting.at < SIM_METRO_STARTING_FRESH_MS) {
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
    const spawnedAt = Date.now()
    const spawned = await options.spawn({
      program: '/bin/sh',
      args: ['-c', command],
      cwd: record.appDir,
      env: simAppEnv(input.app.env, options.env),
      logPath: path
    })
    // Unknown (ps did not answer) still records it: its pid and spawn time find it again.
    const startedAt = spawned.ok ? await control.startOf(spawned.pid) : 'gone'
    await file.update((value) => {
      const current = value.servers.find((other) => simMetroKey(other) === key)
      if (!current) {
        return null
      }
      delete current.starting
      delete current.idleSince
      if (spawned.ok) {
        current.process = {
          pid: spawned.pid,
          ...(typeof startedAt === 'number' ? { startedAt } : {}),
          since: spawnedAt,
          by: self()
        }
      }
      return value
    })
    return spawned.ok
  }

  const ensure = async (
    input: SimMetroInput,
    how: SimMetroEnsureHow,
    tries = 2
  ): Promise<SimMetroEnsure> => {
    const appDir = await appDirOf(input)
    const planned = await plan(input, appDir)
    if (typeof planned === 'string') {
      return { ok: false, message: planned }
    }
    const server = simMetroProcess(planned)
    const [answer, ours] = await Promise.all([
      probe(planned.port, appDir),
      server ? control.state(server) : Promise.resolve('exited' as const)
    ])
    const waiting = {
      ok: true,
      port: planned.port,
      running: false,
      started: false,
      ours: ours !== 'exited',
      logPath: logPath(input)
    } as const
    if (answer === 'ready') {
      return { ...waiting, running: true }
    }
    // Starting, or too busy to answer in time: never a reason to move (a busy Metro keeps its port).
    if (answer === 'starting' || answer === 'unresponsive') {
      return waiting
    }
    if (answer === 'foreign') {
      // Another program answers on the port: Pod's own Metro (if any) lost it; stop it first.
      if (server && ours !== 'exited' && (await control.stop(server)) === 'unknown') {
        return waiting
      }
      if (tries <= 0) {
        return { ok: false, message: `port ${planned.port} answers for another program` }
      }
      const moved = await plan(input, appDir, planned.port)
      return typeof moved === 'string'
        ? { ok: false, message: moved }
        : ensure(input, how, tries - 1)
    }
    // Nothing listens yet: Pod's own process may still be starting up (or ps cannot say).
    if (ours !== 'exited' || !how.start) {
      return waiting
    }
    const command = await commandOf(input, appDir, planned.port)
    if (!command) {
      return waiting
    }
    const started = await start(input, planned, command)
    return { ...waiting, started, ours: started, command }
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
      const server = simMetroProcess(record)
      if (server && answer === 'none' && (await control.state(server)) === 'exited') {
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
      const identity = `${ready.port}:${server ? `${server.pid}:${server.since}` : 'theirs'}`
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
    ensure: (input, how) => ensure(input, how),
    waitReady,
    warm,
    probe,
    reconcile: (inUse) => stopIdleSimMetros({ file, control, now, graceMs: grace }, inUse),
    async unstarted(keys) {
      const read = await file.read()
      return read.ok ? simMetroUnstarted(read.value, keys, now()) : []
    },
    logPath
  }
}
