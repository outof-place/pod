// Fork-only (Pod): the pool's capacity from claude-acc's guard: its boot cap, its brake stage and
// the simulators it sees booted (devguard_core.py Simulator.summary, printed by
// `claude-acc guard status --json`). Devices of Pod's own set are taken out of the "outside" count
// (the guard sees them through their launchd_sim argv). The guard writes the same snapshot into
// its state file every few seconds; while that one is fresh it is read straight from there (a
// fraction of a millisecond, against about 40 ms of CPU for starting claude-acc's Python on every
// poll), else claude-acc is asked, which measures on the spot when its guard is not running.
// Without claude-acc on the Mac, Pod's own cap applies and the brake reads calm.
import type { SimBrake } from '../../../../shared/pod-sim/sim-pool-snapshot'
import { SIM_CAPACITY_FUTURE_MS } from '../pool/sim-pool-config'
import type { SimCapacityPort, SimCapacityReading } from '../pool/sim-pool-ports'
import { simRunProcess, type SimRun } from '../adapters/sim-command-run'

export type ClaudeAccCapacityOptions = Readonly<{
  podCap: number
  // UDIDs of Pod's own devices (its device set on disk); null when the set cannot be read.
  podDevices: () => Promise<ReadonlySet<string> | null>
  // claude-acc's executable, or null when it is not installed.
  binary: string | null
  // The guard's state file (devguard-state.json), whose `snapshot` the CLI prints.
  stateFile: string
  run?: SimRun
  readText?: (path: string) => Promise<string | null>
  now?: () => number
  // Without claude-acc: simulators booted outside Pod's set, from the process table.
  bootedOutsidePod: () => Promise<number | 'unknown'>
}>

/** claude-acc's stages 0..3 (sched.py STAGE_TEXT, `normal` read as calm). */
const BRAKES: readonly SimBrake[] = ['calm', 'tight', 'brake', 'emergency']
/** The CLI prints a stored snapshot younger than this; older, it measures again. */
const STATE_FILE_FRESH_MS = 20_000
const CLI_TIMEOUT_MS = 4_000

const UNKNOWN: SimCapacityReading = {
  source: 'claudeAcc',
  cap: 'unknown',
  outsideBooted: 'unknown',
  agentsInUse: 'unknown',
  brake: 'unknown',
  measuredAt: null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function count(
  simulators: unknown,
  which: (simulator: Record<string, unknown>) => boolean
): number | 'unknown' {
  if (!Array.isArray(simulators)) {
    return 'unknown'
  }
  return simulators.filter((simulator) => isRecord(simulator) && which(simulator)).length
}

/** The core's reading of one guard snapshot; without Pod's own devices, nothing is "outside". */
export function claudeAccReading(
  snapshot: unknown,
  podDevices: ReadonlySet<string> | null
): SimCapacityReading {
  if (!isRecord(snapshot) || typeof snapshot.at !== 'number') {
    return UNKNOWN
  }
  const stage = isRecord(snapshot.pressure) ? snapshot.pressure.stage : undefined
  const cap = snapshot.simulator_cap
  const sims = snapshot.simulators
  return {
    source: 'claudeAcc',
    cap: typeof cap === 'number' && Number.isInteger(cap) && cap >= 0 ? cap : 'unknown',
    outsideBooted: podDevices ? count(sims, (sim) => !podDevices.has(String(sim.udid))) : 'unknown',
    // sched.py simulators_info: pool devices in use, protected ones aside.
    agentsInUse: count(sims, (sim) => sim.in_use === true && sim.pool === true && !sim.protected),
    brake:
      typeof stage === 'number' && Number.isInteger(stage) && stage >= 0 && stage < BRAKES.length
        ? BRAKES[stage]
        : 'unknown',
    measuredAt: Math.round(snapshot.at * 1000)
  }
}

export function createClaudeAccCapacity(options: ClaudeAccCapacityOptions): SimCapacityPort {
  const run = options.run ?? simRunProcess
  const now = options.now ?? Date.now
  const readText = options.readText ?? (async () => null)

  const storedSnapshot = async (): Promise<unknown> => {
    const state = parsed((await readText(options.stateFile)) ?? '')
    const snapshot = isRecord(state) ? state.snapshot : null
    if (!isRecord(snapshot) || typeof snapshot.at !== 'number') {
      return null
    }
    const age = now() - snapshot.at * 1000
    return age < STATE_FILE_FRESH_MS && age >= -SIM_CAPACITY_FUTURE_MS ? snapshot : null
  }

  return {
    async read(): Promise<SimCapacityReading> {
      const [stored, podDevices] = await Promise.all([storedSnapshot(), options.podDevices()])
      if (stored) {
        return claudeAccReading(stored, podDevices)
      }
      if (!options.binary) {
        return {
          source: 'pod',
          cap: options.podCap,
          outsideBooted: podDevices ? await options.bootedOutsidePod() : 'unknown',
          agentsInUse: 'unknown',
          brake: 'calm',
          measuredAt: now()
        }
      }
      const result = await run(options.binary, ['guard', 'status', '--json'], {
        timeoutMs: CLI_TIMEOUT_MS
      })
      if (!result.ok || result.code !== 0) {
        return UNKNOWN
      }
      return claudeAccReading(parsed(result.stdout), podDevices)
    }
  }
}
