// Fork-only (Pod): the lease's app launched on its worktree's Metro, and seen running there. A
// launch is done when the app's JS runs on that Metro (its inspector lists the app on this
// device), not when simctl returns: expo-dev-launcher gives its manifest request 10 s
// (58.0.11, EXDevLauncherController.m EXDevLauncherDefaultRequestTimeout) and shows its own home
// screen when that runs out, which a loaded Mac reaches (Expo runs the expo-updates CLI for every
// manifest). So the wait lasts while the bundle builds (the warm-up says when) and Metro first
// answers the list, plus a grace, and a launch that never reached Metro is retried once. A Metro
// too busy to answer in time, or one bad answer (a 500 mid-reload, a cut body), is asked again; it
// says it has no list only when it says so three times in a row.
import type { SimAppDevice } from './sim-app-device'
import type { SimMetroInput, SimMetros } from './sim-app-metro'
import { simAppOnMetro, type SimMetroWarm } from './sim-app-metro-http'

/** After the bundle is built, how long the app may take to show up on Metro. */
export const SIM_APP_CONNECT_MS = 20_000
/** How long Metro may stay too busy to answer its list at all before Pod stops asking. */
export const SIM_APP_LIST_PATIENCE_MS = 30_000
const NO_LIST_IN_A_ROW = 3

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

/**
 * Polls Metro until the app is on it, or `connectMs` past both its bundle being built and Metro
 * answering the list; a Metro that never answers is given up SIM_APP_LIST_PATIENCE_MS past the bundle.
 */
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
  let answeredAt: number | null = null
  let noList = 0
  for (;;) {
    const on = await simAppOnMetro(port, bundleId, deviceName)
    if (on === true) {
      return { on: true }
    }
    noList = on === 'noList' ? noList + 1 : 0
    if (noList >= NO_LIST_IN_A_ROW) {
      return { on: null }
    }
    if (on === false) {
      answeredAt ??= performance.now()
    }
    const at = performance.now()
    if (bundled.at !== null) {
      if (answeredAt === null) {
        // A Metro too busy to ever answer cannot say the app is missing.
        if (at - bundled.at > Math.max(connectMs, SIM_APP_LIST_PATIENCE_MS)) {
          return { on: null }
        }
      } else if (at - Math.max(bundled.at, answeredAt) > connectMs) {
        return bundled.problem ? { on: false, bundleProblem: bundled.problem } : { on: false }
      }
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
