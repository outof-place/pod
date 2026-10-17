// The shared Mac's gate for a heavy step, read right before each one:
// - /tmp/pod-bench-hold exists: only a run given a GO (POD_BENCH_GO=1) passes;
// - /tmp/pod-heavy-state is one line, `GO until=HH:MM ...` or `HOLD <reason>`: only GO passes,
//   and only up to 10 minutes before `until`;
// - the 1-minute load average is under 60 and the Data volume has at least 30 GiB free.
//
//   node bench/lib/heavy-gate.mjs     exit 0 to go, 75 (held) with the reason on stderr
import { existsSync, readFileSync, realpathSync, statfsSync } from 'node:fs'
import os from 'node:os'

export const HELD_EXIT_CODE = 75
const MIN_FREE_GIB = 30
const MAX_LOAD = 60
const END_MARGIN_MIN = 10

/** Whether the state line lets a step start at `now`; returns null when it does, else the reason. */
export function stateRefusal(line, now) {
  const text = (line ?? '').trim()
  if (!text.startsWith('GO')) {
    return `heavy state is not GO: ${text || '(missing)'}`
  }
  const until = text.match(/\buntil=(\d{1,2}):(\d{2})\b/)
  if (!until) {
    return `heavy state GO names no until=HH:MM: ${text}`
  }
  const end = new Date(now)
  end.setHours(Number(until[1]), Number(until[2]), 0, 0)
  if (now.getTime() >= end.getTime() - END_MARGIN_MIN * 60_000) {
    return `the GO window ends at ${until[1]}:${until[2]}: no step starts within ${END_MARGIN_MIN} min of its end`
  }
  return null
}

export function heavyGate({
  now = new Date(),
  env = process.env,
  stateFile = '/tmp/pod-heavy-state',
  holdFile = '/tmp/pod-bench-hold',
  volume = '/System/Volumes/Data',
  load = os.loadavg()[0],
  freeGiB = null
} = {}) {
  if (existsSync(holdFile) && env.POD_BENCH_GO !== '1') {
    return `bench hold (${realpathSync(holdFile)}) and no GO for this run (POD_BENCH_GO=1)`
  }
  const refusal = stateRefusal(existsSync(stateFile) ? readFileSync(stateFile, 'utf8').split('\n')[0] : null, now)
  if (refusal) {
    return refusal
  }
  if (load >= MAX_LOAD) {
    return `1-minute load ${load.toFixed(1)} is at or over ${MAX_LOAD}`
  }
  const stats = freeGiB === null ? statfsSync(volume) : null
  const free = stats ? (stats.bavail * stats.bsize) / 2 ** 30 : freeGiB
  if (free < MIN_FREE_GIB) {
    return `${volume} has ${free.toFixed(1)} GiB free, under ${MIN_FREE_GIB}`
  }
  return null
}

/** Throws (for a suite to stop on) unless the gate lets the next heavy step start. */
export function assertHeavyGate(where) {
  const refusal = heavyGate()
  if (refusal) {
    const error = new Error(`held before ${where}: ${refusal}`)
    error.held = true
    throw error
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === import.meta.filename) {
  const refusal = heavyGate()
  if (refusal) {
    console.error(`held: ${refusal}`)
    process.exit(HELD_EXIT_CODE)
  }
}
