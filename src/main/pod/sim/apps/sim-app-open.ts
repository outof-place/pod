// Fork-only (Pod): a lease's app opened on its device. It installs the client when the device lacks
// this fingerprint's, waits for the worktree's Metro, and launches the app on it, unless the app
// already runs there and no relaunch was asked (stage 0: a relaunch is an 8 to 10 s JS reload).
//
// The recipe's appDefaults reach the app as launch arguments (`-Key value`, Foundation's argument
// domain): `UserDefaults.standard` reads them over the app's own and registered values, which is all
// expo-dev-menu 58.0.10 does (DevMenuPreferences.swift `bool(forKey:)`). Writing them with
// `simctl spawn defaults write` was tried and dropped: it landed outside the app's container, so the
// app never read it, and each write cost seconds on a freshly booted device.
import type { SimAppDevice, SimInstalledRecords } from './sim-app-device'
import type { SimClientLookup } from './sim-app-client-lookup'
import { simHopTimer, type SimAppHops } from './sim-app-hops'
import { launchSimAppOnMetro } from './sim-app-launch'
import { SIM_METRO_READY_MS, type SimMetroEnsure, type SimMetros } from './sim-app-metro'
import { simAppOnMetro } from './sim-app-metro-http'
import {
  simAppUnavailable,
  type SimAppPrepareInput,
  type SimAppRefused,
  type SimAppResolved
} from './sim-app-resolve'

export type SimAppRef = Readonly<{ id: string; bundleId: string }>

export type SimAppOpenInput = SimAppPrepareInput &
  Readonly<{
    udid: string
    // `podx sim open`: launch again even when it already runs on this Metro.
    relaunch?: boolean
    // Reinstall even when the device has this fingerprint's client (`reset`).
    reinstall?: boolean
  }>

export type SimAppOpened =
  | Readonly<{
      ok: true
      app: SimAppRef
      // Null for an app whose recipe names no Metro.
      metroPort: number | null
      installed: boolean
      // False when the app already ran on this worktree's Metro and no relaunch was asked.
      launched: boolean
      // Its JS runs on the worktree's Metro (sim-app-launch.ts); null when that cannot be seen.
      connected: boolean | null
      // Why it is not on Metro: the bundle failed to build, or two launches never reached it.
      problem?: string
      ms: SimAppHops
    }>
  | SimAppRefused

/** expo-dev-launcher's `--initialUrl`, then each default as `-Key value`. */
export function simAppLaunchArgs(
  port: number | null,
  defaults: Readonly<Record<string, boolean | number | string>> | undefined
): string[] {
  const args = port === null ? [] : ['--initialUrl', `http://127.0.0.1:${port}`]
  for (const [key, value] of Object.entries(defaults ?? {})) {
    args.push(`-${key}`, typeof value === 'boolean' ? (value ? 'YES' : 'NO') : String(value))
  }
  return args
}

export type SimAppOpenDeps = Readonly<{
  resolve: (input: SimAppPrepareInput) => Promise<SimAppResolved>
  lookup: SimClientLookup
  device: SimAppDevice
  installed: SimInstalledRecords
  metros: SimMetros
  now: () => number
  connectMs: number
}>

export function createSimAppOpen(
  deps: SimAppOpenDeps
): (input: SimAppOpenInput) => Promise<SimAppOpened> {
  const { device, installed, metros, now } = deps

  return async (input) => {
    const time = simHopTimer()
    const resolved = await deps.resolve(input)
    if (!resolved.ok) {
      return resolved
    }
    const { id, app } = resolved
    const ref = { id, bundleId: app.bundleId }
    time.hop('recipe')
    const metroInput = { worktreeRoot: input.worktreeRoot, appId: id, app }
    // The lease holds a device: its Metro starts now. A failure is an answer, never left unheard.
    const metro = app.metro
      ? metros
          .ensure(metroInput, { start: true })
          .catch((error: unknown): SimMetroEnsure => ({ ok: false, message: String(error) }))
      : null
    const found = await deps.lookup.find(
      { worktreeRoot: input.worktreeRoot, id, app, startBuild: false },
      time
    )
    if ('refusal' in found) {
      return { ok: false, refusal: found.refusal }
    }
    if (found.client.state !== 'cached' || !found.fingerprint) {
      await metro
      return simAppUnavailable(
        `the ${id} dev client cannot be installed: ${found.client.state === 'missing' ? found.client.why : 'it is still building'}.`
      )
    }
    const record = await installed.get(input.udid, app.bundleId)
    // Whether it runs matters only when it may already run on this worktree's Metro.
    const mayRun =
      !input.relaunch && !input.reinstall && record?.launched?.worktreeRoot === input.worktreeRoot
    const [present, running] = await Promise.all([
      device.appInstalled(input.udid, app.bundleId),
      mayRun ? device.appRunning(input.udid, app.bundleId) : false
    ])
    time.hop('deviceCheck')
    const install = input.reinstall || record?.fingerprint !== found.fingerprint || present !== true
    if (install) {
      const done = await device.install(input.udid, found.client.path)
      time.hop('install')
      if (!done.ok) {
        await metro
        return simAppUnavailable(`installing the ${id} dev client failed: ${done.message}`)
      }
      await installed.set(input.udid, app.bundleId, {
        fingerprint: found.fingerprint,
        installedAt: now()
      })
    }
    const started = await metro
    time.hop('metroEnsure')
    if (started && !started.ok) {
      return simAppUnavailable(`Metro for ${id}: ${started.message}`)
    }
    const port = started?.port ?? null
    // Running from this Metro's last launch, and (when Metro can say) its JS still on Metro: a
    // launch that stopped at the dev launcher is launched again.
    const there =
      !install &&
      running === true &&
      record?.launched?.port === (port ?? 0) &&
      (port === null ||
        (await simAppOnMetro(port, app.bundleId, await device.deviceName(input.udid))) !== false)
    if (there) {
      time.hop('onMetro')
      return {
        ok: true,
        app: ref,
        metroPort: port,
        installed: false,
        launched: false,
        connected: port === null ? null : true,
        ms: time.ms
      }
    }
    if (started) {
      // The app's own bundle request joins this build when it comes first.
      void metros.warm(metroInput).catch(() => undefined)
      if (!started.running) {
        const ready = await metros.waitReady(metroInput, SIM_METRO_READY_MS)
        time.hop('metroReady')
        if (!ready.ok) {
          return simAppUnavailable(`Metro for ${id}: ${ready.message}`)
        }
      }
    }
    const launched = await launchSimAppOnMetro(
      { device, metros },
      {
        udid: input.udid,
        bundleId: app.bundleId,
        args: simAppLaunchArgs(port, app.appDefaults),
        port,
        metroInput,
        connectMs: deps.connectMs
      }
    )
    time.hop('launchToMetro')
    if (!launched.ok) {
      return simAppUnavailable(`launching ${id} failed: ${launched.message}`)
    }
    const latest = await installed.get(input.udid, app.bundleId)
    await installed.set(input.udid, app.bundleId, {
      fingerprint: latest?.fingerprint ?? found.fingerprint,
      installedAt: latest?.installedAt ?? now(),
      launched: { worktreeRoot: input.worktreeRoot, port: port ?? 0, at: now() }
    })
    return {
      ok: true,
      app: ref,
      metroPort: port,
      installed: install,
      launched: true,
      connected: launched.connected,
      ...(launched.problem ? { problem: launched.problem } : {}),
      ms: time.ms
    }
  }
}
