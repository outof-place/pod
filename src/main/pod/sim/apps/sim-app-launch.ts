// Fork-only (Pod): the lease's app launched on its worktree's Metro, and seen running there. A
// launch is done when the app's JS runs on that Metro (its inspector lists the app on this
// device), not when simctl returns: expo-dev-launcher gives its manifest request 10 s
// (58.0.11, EXDevLauncherController.m EXDevLauncherDefaultRequestTimeout) and shows its own home
// screen when that runs out, which a loaded Mac reaches (Expo runs the expo-updates CLI for every
// manifest). So the wait lasts while the bundle builds (the warm-up says when) plus a grace, and a
// launch that never reached Metro is retried once.
import type { SimAppDevice } from './sim-app-device'
import type { SimMetroInput, SimMetros } from './sim-app-metro'
import { simAppOnMetro, type SimMetroWarm } from './sim-app-metro-http'

/** After the bundle is built, how long the app may take to show up on Metro. */
export const SIM_APP_CONNECT_MS = 20_000

export type SimAppLaunched =
  | Readonly<{
      ok: true
      // Null: no Metro to see it on, or one without an inspector list.
      connected: boolean | null
      launches: number
      problem?: string
    }>
  | Readonly<{ ok: false; message: string }>

export type SimAppLaunchInput = Readonly<{
  udid: string
  bundleId: string
  args: readonly string[]
  // Null for an app whose recipe names no Metro.
  port: number | null
  metroInput: SimMetroInput
  connectMs: number
}>

type Seen = Readonly<{ on: boolean | null; bundleProblem?: string }>

/** Polls Metro until the app is on it, or `connectMs` past its bundle being built. */
async function waitOnMetro(
  port: number,
  bundleId: string,
  deviceName: string | null,
  bundle: Promise<SimMetroWarm | null>,
  connectMs: number
): Promise<Seen> {
  const bundled: { at: number | null; problem?: string } = { at: null }
  void bundle.then((warmed) => {
    bundled.at = performance.now()
    // A non-Expo Metro has no manifest to warm from: only a failed build is a problem.
    if (warmed && !warmed.ok && !warmed.message.startsWith('no Expo manifest')) {
      bundled.problem = warmed.message
    }
  })
  let answered = false
  for (;;) {
    const on = await simAppOnMetro(port, bundleId, deviceName)
    if (on === true) {
      return { on: true }
    }
    if (on === 'noList') {
      return { on: null }
    }
    answered ||= on === false
    if (bundled.at !== null && performance.now() - bundled.at > connectMs) {
      // A Metro too busy to ever answer cannot say the app is missing.
      if (!answered) {
        return { on: null }
      }
      return bundled.problem ? { on: false, bundleProblem: bundled.problem } : { on: false }
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

export async function launchSimAppOnMetro(
  deps: Readonly<{ device: SimAppDevice; metros: SimMetros }>,
  input: SimAppLaunchInput
): Promise<SimAppLaunched> {
  const launch = () => deps.device.launch(input.udid, input.bundleId, input.args)
  const first = await launch()
  if (!first.ok) {
    return first
  }
  if (input.port === null) {
    return { ok: true, connected: null, launches: 1 }
  }
  const deviceName = await deps.device.deviceName(input.udid)
  // In flight (shared with prepare's), done, or null when this Metro process already has it.
  const bundle = deps.metros.warm(input.metroInput).catch(() => null)
  for (let launches = 1; ; launches += 1) {
    const seen = await waitOnMetro(input.port, input.bundleId, deviceName, bundle, input.connectMs)
    if (seen.on !== false) {
      return { ok: true, connected: seen.on, launches }
    }
    if (seen.bundleProblem || launches >= 2) {
      return {
        ok: true,
        connected: false,
        launches,
        problem:
          seen.bundleProblem ??
          `the app did not reach Metro on port ${input.port} within ${Math.round(input.connectMs / 1000)} s of its bundle, twice`
      }
    }
    const again = await launch()
    if (!again.ok) {
      return again
    }
  }
}
