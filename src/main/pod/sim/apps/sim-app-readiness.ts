// Fork-only (Pod): the app module, stage 5's whole surface. A lease's app is ready when its
// worktree's recipe names it, its native fingerprint has a dev client in the Mac-wide cache (Pod's
// own, adopted from the recipe's external cache, or built once for the whole Mac), its Metro runs on
// the worktree's own port, and the client is installed and launched on that Metro.
//
//   prepare   at `lease`: recipe, app, fingerprint, client (or the build to wait for), and Metro
//             started and its bundle warmed in the background. A lease waits on `buildId`
//             (`waitingFor: build`).
//   open      once the lease has a device (sim-app-open.ts).
//   port      the pool's SimAppPort: `reset app` and the reinstall after `reset device`.
//   reconcile after each pool poll and release (stage 7 wires it): ends builds whose process ended
//             and answers a `buildFinished` command per build a lease waits on, and stops Metros
//             whose worktree's last lease is gone.
//
// Everything here runs on this Mac (sim-app-resolve.ts).
import type { SimRecipeDiagnostic } from '../../../../shared/pod-sim/sim-recipe'
import type { SimRefusalInput } from '../../../../shared/pod-sim/sim-refusals'
import type { SimRun } from '../adapters/sim-command-run'
import type { SimPodHome, SimPodHomeClaim } from '../adapters/sim-pod-home'
import type { SimProcessFacts } from '../adapters/sim-process-facts'
import type { SimPoolCommand } from '../pool/sim-pool-commands'
import type { SimAppPort, SimProcessId, SimRegistryStore, SimRuntime } from '../pool/sim-pool-ports'
import type { SimBuild } from './sim-app-build-records'
import { createSimBuilds } from './sim-app-builds'
import { createSimClientCache, type SimClientCache } from './sim-app-clients'
import { createSimClientLookup, type SimAppClient } from './sim-app-client-lookup'
import { createSimInstalledRecords, type SimAppDevice } from './sim-app-device'
import { createSimFingerprints, type SimFingerprints } from './sim-app-fingerprint'
import { simHopTimer, type SimAppHops } from './sim-app-hops'
import { SIM_APP_CONNECT_MS } from './sim-app-launch'
import { createSimMetros } from './sim-app-metro'
import {
  createSimAppOpen,
  type SimAppOpened,
  type SimAppOpenInput,
  type SimAppRef
} from './sim-app-open'
import { simAppHome } from './sim-app-paths'
import { resolveSimApp, type SimAppPrepareInput, type SimAppRefused } from './sim-app-resolve'
import type { SimShell } from './sim-app-shell'
import {
  createSimProcessControl,
  simSpawnDetached,
  type SimDetachedSpawn,
  type SimProcessControl
} from './sim-app-spawn'

export type SimAppPrepared =
  | Readonly<{
      ok: true
      app: SimAppRef
      fingerprint: string | null
      client: SimAppClient
      metro: Readonly<{
        port: number
        running: boolean
        startedByPod: boolean
        logPath: string
      }> | null
      metroProblem?: string
      warnings: readonly SimRecipeDiagnostic[]
      ms: SimAppHops
    }>
  | SimAppRefused

export type SimApps = {
  prepare(input: SimAppPrepareInput): Promise<SimAppPrepared>
  open(input: SimAppOpenInput): Promise<SimAppOpened>
  readonly port: SimAppPort
  reconcile(): Promise<SimPoolCommand[]>
  /** A build as a waiting lease shows it (progress, phase), or null. */
  build(buildId: string): Promise<SimBuild | null>
  /** The `build_failed` refusal for a lease that build ended, with its log's tail. */
  buildRefusal(buildId: string, app?: string): Promise<SimRefusalInput | null>
  /** The pool snapshot's `builds`. */
  builds(): Promise<SimBuild[]>
}

export type SimAppsOptions = Readonly<{
  home: SimPodHome
  claim: () => Promise<SimPodHomeClaim>
  store: SimRegistryStore
  device: SimAppDevice
  self: SimRuntime
  processes: SimProcessFacts
  runtimeState: (ref: SimProcessId) => Promise<'live' | 'exited'>
  claudeAcc: string | null
  run: SimRun
  userHome: string
  // A build this runtime started ended: run `buildFinished` on the pool at once.
  onBuildFinished?: (buildId: string, ok: boolean) => void
  shell?: SimShell
  spawn?: SimDetachedSpawn
  control?: SimProcessControl
  fingerprints?: SimFingerprints
  clients?: SimClientCache
  metroGraceMs?: number
  // After the bundle is built, how long a launched app may take to reach Metro.
  connectMs?: number
  now?: () => number
  env?: NodeJS.ProcessEnv
}>

export function createSimApps(options: SimAppsOptions): SimApps {
  const home = simAppHome(options.home)
  const control = options.control ?? createSimProcessControl(options.processes)
  const spawn = options.spawn ?? simSpawnDetached
  const now = options.now ?? Date.now
  const clients =
    options.clients ??
    createSimClientCache({ home, run: options.run, userHome: options.userHome, now })
  const fingerprints =
    options.fingerprints ??
    createSimFingerprints({ ...(options.shell ? { shell: options.shell } : {}), env: options.env })
  const builds = createSimBuilds({
    home,
    clients,
    spawn,
    control,
    self: options.self,
    runtimeState: options.runtimeState,
    claudeAcc: options.claudeAcc,
    now,
    env: options.env,
    onFinished: (finished) => {
      if (finished.ok) {
        void clients.evict(new Set()).catch(() => undefined)
      }
      options.onBuildFinished?.(finished.buildId, finished.ok)
    }
  })
  const metros = createSimMetros({
    home,
    spawn,
    control,
    self: options.self,
    now,
    env: options.env,
    ...(options.metroGraceMs !== undefined ? { graceMs: options.metroGraceMs } : {})
  })
  const installed = createSimInstalledRecords(home)
  const lookup = createSimClientLookup({ fingerprints, clients, builds })
  const resolve = (input: SimAppPrepareInput) =>
    resolveSimApp(input, { claim: options.claim, recipesFile: home.recipes })
  const open = createSimAppOpen({
    resolve,
    lookup,
    device: options.device,
    installed,
    metros,
    now,
    connectMs: options.connectMs ?? SIM_APP_CONNECT_MS
  })

  /** The lease's worktree and app from the registry, for the pool's app port. */
  const leaseApp = async (leaseId: string) => {
    const read = await options.store.read()
    const lease = read.ok ? read.registry.leases.find((other) => other.leaseId === leaseId) : null
    return lease?.app ? { worktreeRoot: lease.worktreeRoot, app: lease.app.id } : null
  }

  const port: SimAppPort = {
    async reset(udid, leaseId) {
      const lease = await leaseApp(leaseId)
      if (!lease) {
        return
      }
      const resolved = await resolve(lease)
      if (resolved.ok) {
        await options.device.uninstall(udid, resolved.app.bundleId)
        await installed.set(udid, resolved.app.bundleId, null)
      }
      await open({ ...lease, udid, relaunch: true, reinstall: true })
    },
    async reinstall(udid, leaseId) {
      // The device was erased: whatever Pod installed on it is gone.
      await installed.forget(udid)
      const lease = await leaseApp(leaseId)
      if (lease) {
        await open({ ...lease, udid, relaunch: true, reinstall: true })
      }
    }
  }

  const snapshot = async () => {
    const read = await options.store.read()
    return builds.snapshot(read.ok ? read.registry : null)
  }

  return {
    async prepare(input) {
      const time = simHopTimer()
      const resolved = await resolve(input)
      if (!resolved.ok) {
        return resolved
      }
      const { id, app, warnings } = resolved
      time.hop('recipe')
      const metroInput = { worktreeRoot: input.worktreeRoot, appId: id, app }
      // Metro starts, then builds the client's bundle, while the device is found and booted.
      const metro = app.metro
        ? metros.ensure(metroInput).then((started) => {
            if (started.ok) {
              void metros.warm(metroInput).catch(() => undefined)
            }
            return started
          })
        : null
      const found = await lookup.find(
        { worktreeRoot: input.worktreeRoot, id, app, startBuild: true },
        time
      )
      if ('refusal' in found) {
        await metro
        return { ok: false, refusal: found.refusal }
      }
      const started = await metro
      time.hop('metro')
      return {
        ok: true,
        app: { id, bundleId: app.bundleId },
        fingerprint: found.fingerprint,
        client: found.client,
        metro: started?.ok
          ? {
              port: started.port,
              running: started.running,
              logPath: started.logPath,
              // False: Pod has no command for it (no metro.command, not an Expo app).
              startedByPod: started.running || started.command !== undefined
            }
          : null,
        ...(started && !started.ok ? { metroProblem: started.message } : {}),
        warnings,
        ms: time.ms
      }
    },

    open,
    port,

    async reconcile() {
      const read = await options.store.read()
      const registry = read.ok ? read.registry : null
      const ended = await builds.check()
      const commands: SimPoolCommand[] = ended.map((finished) => ({
        kind: 'buildFinished',
        buildId: finished.buildId,
        ok: finished.ok
      }))
      const answered = new Set(ended.map((finished) => finished.buildId))
      const all = await builds.all()
      // A lease that joined a build after it ended (between prepare and its lease call) hears it now.
      for (const lease of all ? (registry?.leases ?? []) : []) {
        const buildId = lease.queue?.buildId
        if (!buildId || answered.has(buildId)) {
          continue
        }
        const build = all?.find((other) => other.buildId === buildId)
        if (!build || build.state !== 'building') {
          answered.add(buildId)
          commands.push({ kind: 'buildFinished', buildId, ok: build?.state === 'done' })
        }
      }
      if (registry) {
        await metros.reconcile(registry)
      }
      return commands
    },

    async build(buildId) {
      return (await snapshot()).find((build) => build.buildId === buildId) ?? null
    },

    buildRefusal: (buildId, app) => lookup.buildRefusal(buildId, app),
    builds: snapshot
  }
}
