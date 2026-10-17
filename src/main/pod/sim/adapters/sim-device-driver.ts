// Fork-only (Pod): the pool's device driver, simctl and simslim in Pod's own device set. simctl
// with `--set` sees that set alone, so its calls cannot reach the default set or a running
// Simulator.app. simslim's `--set` only adds a set: it always scans the default and Xcode testing
// sets as well, so every simslim call first checks its UDID is a directory in Pod's set, and a
// clone's new UDID is read from its JSON and checked the same way. Each op answers within its own
// timeout, set under the core's op deadline (SIM_OP_DEADLINE_MS), so the outcome lands before the
// core gives up on it; nothing throws. The app module (stage 5) installs and launches the lease's
// dev client through the same simctl, in the same set (SimAppDevice).
import type { SimAppDevice } from '../apps/sim-app-device'
import type {
  SimDeviceDriver,
  SimDeviceObservation,
  SimOpOutcome,
  SimSlimProfile
} from '../pool/sim-pool-ports'
import { simRunFailure, simRunProcess, type SimRun, type SimRunResult } from './sim-command-run'
import { simDeviceAppOps } from './sim-device-app-ops'
import { simDevicesOnDisk } from './sim-pod-home'
import type { SimProcessFacts } from './sim-process-facts'
import { parseSimctlList, SIM_UDID_IN_TEXT, userAppsRunning } from './sim-simctl-output'
import { resolveSimTools, type SimTools } from './sim-tools'

export type SimDeviceDriverOptions = Readonly<{
  deviceSet: string
  run?: SimRun
  // simctl refuses a `--set` path that does not exist: this claims Pod's home and makes the set
  // (sim-pod-home.ts), or throws why it may not.
  ensureSet: (deviceSet: string) => Promise<void>
  tools?: () => Promise<SimTools>
  // null: the set cannot be read.
  devicesOnDisk?: (deviceSet: string) => Promise<Set<string> | null>
  // The simslim profile file for a lease's app (stage 5b derives them); null: simslim's default,
  // every slimmable category off.
  slimProfileFile?: (profile: SimSlimProfile) => string | null
  // Tells which apps run without `simctl spawn` (sim-device-app-ops.ts).
  processes?: SimProcessFacts | null
}>

// Under SIM_OP_DEADLINE_MS, each with room for the outcome's own step. Measured on Xcode 27 with
// iOS 26.5 under load: simslim on a fresh device 67 s (its first boot), after an erase 77 s;
// verify 1 s; shutdown 3 to 4 s; a slim device's boot 5 to 13 s; create 0.4 to 0.9 s.
const TIMEOUT_MS = {
  list: 5_000,
  create: 110_000,
  clone: 110_000,
  boot: 170_000,
  // prepare: slim, settle, verify and shut down within its 5 min deadline.
  slim: 200_000,
  settle: 30_000,
  verify: 30_000,
  shutdown: 100_000,
  slimShutdown: 30_000,
  erase: 60_000,
  // release: list the apps, then end them all at once, inside its 60 s deadline.
  releaseList: 15_000,
  release: 40_000,
  delete: 100_000
} as const

const ALREADY_SHUT_DOWN = /current state: Shutdown/i
const NO_SUCH_DEVICE = /Invalid device/i
const SET_MISSING = /set path does not exist/i
// simctl terminate for an app that quit meanwhile (launchd's ESRCH).
const NOT_RUNNING = /found nothing to terminate|No such process|is not running/i

const DONE: SimOpOutcome = { ok: true }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The new device's UDID from `simslim clone --json`, or null. */
function clonedUdid(stdout: string): string | null {
  try {
    const json: unknown = JSON.parse(stdout)
    const udid = isRecord(json) ? json.udid : undefined
    return typeof udid === 'string' && new RegExp(`^${SIM_UDID_IN_TEXT.source}$`).test(udid)
      ? udid
      : null
  } catch {
    return null
  }
}

export function createSimDeviceDriver(
  options: SimDeviceDriverOptions
): SimDeviceDriver & SimAppDevice {
  const run = options.run ?? simRunProcess
  const onDisk = options.devicesOnDisk ?? simDevicesOnDisk
  const profileFile = options.slimProfileFile ?? (() => null)
  const { ensureSet } = options
  let setReady: Promise<void> | null = null
  let tools: Promise<SimTools> | null = null
  const toolsOnce = async (): Promise<SimTools> => {
    tools ??= (options.tools ?? (() => resolveSimTools(run)))()
    const found = await tools
    if (!found.simctl) {
      // Not cached: Xcode may be installed or selected by the next call.
      tools = null
    }
    return found
  }

  const simctl = async (args: readonly string[], timeoutMs: number): Promise<SimRunResult> => {
    const program = (await toolsOnce()).simctl
    if (!program) {
      return {
        ok: false,
        reason: 'spawn',
        message: 'xcrun found no simctl: install Xcode, or select it with xcode-select'
      }
    }
    try {
      await (setReady ??= ensureSet(options.deviceSet))
    } catch (error) {
      setReady = null
      return { ok: false, reason: 'spawn', message: `${options.deviceSet}: ${String(error)}` }
    }
    const result = await run(program, ['--set', options.deviceSet, ...args], { timeoutMs })
    if (result.ok && SET_MISSING.test(result.stderr)) {
      // Someone removed Pod's set since: the next call makes it again.
      setReady = null
    }
    return result
  }

  /** simslim on `udid`, which must be a directory in Pod's set: simslim also scans the default set. */
  const simslim = async (
    udid: string,
    args: readonly string[],
    timeoutMs: number
  ): Promise<SimRunResult> => {
    const program = (await toolsOnce()).simslim
    if (!program) {
      return {
        ok: false,
        reason: 'spawn',
        message:
          'simslim is not installed; Pod slims every simulator with it (brew install mobai-app/tap/simslim)'
      }
    }
    const present = await onDisk(options.deviceSet)
    if (!present?.has(udid)) {
      return {
        ok: false,
        reason: 'spawn',
        message: `${udid} is not a device of Pod's set ${options.deviceSet}; simslim would look in the default set too`
      }
    }
    return run(program, ['--set', options.deviceSet, ...args], { timeoutMs })
  }

  const step = async (
    what: string,
    result: Promise<SimRunResult>,
    tolerate?: RegExp
  ): Promise<string | null> => {
    const done = await result
    if (done.ok && (done.code === 0 || (tolerate && tolerate.test(done.stderr)))) {
      return null
    }
    return simRunFailure(what, done)
  }

  const outcome = (failure: string | null): SimOpOutcome =>
    failure ? { ok: false, message: failure } : DONE

  const profileArgs = (profile: SimSlimProfile): string[] => {
    const file = profileFile(profile)
    return file ? ['--profile', file] : []
  }

  /** simslim on, then wait for the device to be up and check the slim holds; leaves it booted. */
  const slim = async (udid: string, profile: SimSlimProfile): Promise<string | null> =>
    (await step(
      'simslim on',
      simslim(udid, ['on', udid, ...profileArgs(profile)], TIMEOUT_MS.slim)
    )) ??
    // simslim leaves the device booted; this only waits out a boot still settling.
    (await step('boot', simctl(['bootstatus', udid, '-b'], TIMEOUT_MS.settle))) ??
    (await step(
      'simslim verify',
      simslim(udid, ['verify', udid, ...profileArgs(profile)], TIMEOUT_MS.verify)
    ))

  const shutDown = (udid: string, timeoutMs: number = TIMEOUT_MS.shutdown) =>
    step('simctl shutdown', simctl(['shutdown', udid], timeoutMs), ALREADY_SHUT_DOWN)

  return {
    async observe(): Promise<SimDeviceObservation> {
      const [listed, present] = await Promise.all([
        simctl(['list', 'devices', '-j'], TIMEOUT_MS.list),
        onDisk(options.deviceSet)
      ])
      if (!listed.ok || listed.code !== 0) {
        return { verdict: 'unknown', why: simRunFailure('simctl list', listed) }
      }
      if (!present) {
        return { verdict: 'unknown', why: `${options.deviceSet} cannot be read` }
      }
      const parsed = parseSimctlList(listed.stdout)
      if (!parsed) {
        return { verdict: 'unknown', why: 'simctl list printed something other than its JSON' }
      }
      // CoreSimulator restarting (or another Xcode's) can list nothing for a set it still keeps.
      if (parsed.length === 0 && present.size > 0) {
        return {
          verdict: 'unknown',
          why: `simctl listed no devices but ${present.size} are on disk in ${options.deviceSet}`
        }
      }
      return { verdict: 'ok', devices: parsed, onDisk: [...present].sort() }
    },

    async create(name, deviceType, runtime) {
      const result = await simctl(['create', name, deviceType, runtime], TIMEOUT_MS.create)
      const udid =
        result.ok && result.code === 0 ? result.stdout.match(SIM_UDID_IN_TEXT)?.[0] : null
      return udid
        ? { ok: true, udid }
        : { ok: false, message: simRunFailure('simctl create', result) }
    },

    async clone(source, name) {
      // CoreSimulator's own clone keeps absolute paths into its source (its boots write there);
      // simslim's rebases them, rebuilds app registrations and carries the slim profile over. It
      // boots the source to read its services and the clone to check it, one at a time (simslim
      // 0.12.2 clone.go), so a source never booted before runs past this op's timeout.
      const result = await simslim(source, ['clone', '--json', source, name], TIMEOUT_MS.clone)
      if (!result.ok || result.code !== 0) {
        return { ok: false, message: simRunFailure('simslim clone', result) }
      }
      const udid = clonedUdid(result.stdout)
      if (!udid) {
        return { ok: false, message: 'simslim clone printed no JSON naming the new device' }
      }
      if (!(await onDisk(options.deviceSet))?.has(udid)) {
        return { ok: false, message: `simslim cloned to ${udid}, which is not in Pod's set` }
      }
      return { ok: true, udid }
    },

    async prepare(udid, profile) {
      const failure = await slim(udid, profile)
      const down = await shutDown(udid, TIMEOUT_MS.slimShutdown)
      return outcome(failure ?? down)
    },

    async boot(udid) {
      return outcome(await step('boot', simctl(['bootstatus', udid, '-b'], TIMEOUT_MS.boot)))
    },

    async shutDown(udid) {
      return outcome(await shutDown(udid))
    },

    async release(udid) {
      const deadline = performance.now() + TIMEOUT_MS.release
      const listed = await simctl(['spawn', udid, 'launchctl', 'list'], TIMEOUT_MS.releaseList)
      if (!listed.ok || listed.code !== 0) {
        return { ok: false, message: simRunFailure('launchctl list', listed) }
      }
      const left = Math.max(1_000, deadline - performance.now())
      const failures = await Promise.all(
        userAppsRunning(listed.stdout).map((bundleId) =>
          // An app that quit meanwhile is as good as terminated.
          step(
            `simctl terminate ${bundleId}`,
            simctl(['terminate', udid, bundleId], left),
            NOT_RUNNING
          )
        )
      )
      return outcome(failures.find((failure) => failure !== null) ?? null)
    },

    async reset(udid, profile) {
      return outcome(
        (await shutDown(udid)) ??
          (await step('simctl erase', simctl(['erase', udid], TIMEOUT_MS.erase))) ??
          (await slim(udid, profile))
      )
    },

    async delete(udid) {
      return outcome(
        await step('simctl delete', simctl(['delete', udid], TIMEOUT_MS.delete), NO_SUCH_DEVICE)
      )
    },

    ...simDeviceAppOps(simctl, step, {
      deviceSet: options.deviceSet,
      run,
      processes: options.processes ?? null
    })
  }
}
