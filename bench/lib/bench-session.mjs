// Run conditions shared by every suite: machine facts, the load gate, sample collection, and
// the raw result file each suite writes under results/<date>/.
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BENCHMARK_SAMPLE_AGGREGATION, summarize } from './sample-stats.mjs'

export const BENCH_ROOT = path.dirname(import.meta.dirname)
export const TOOLS_BIN = path.join(BENCH_ROOT, '.build', 'bin')

/** A sample counts only when the 1-minute load average was at or below this when it started. */
export const MAX_LOAD = Number(process.env.POD_BENCH_MAX_LOAD ?? 8)
const QUIET_TIMEOUT_MS = Number(process.env.POD_BENCH_QUIET_TIMEOUT_MS ?? 60 * 60_000)
const QUIET_POLL_MS = 15_000

export function log(...parts) {
  console.error(`[${new Date().toISOString().slice(11, 19)}]`, ...parts)
}

export function loadAverage() {
  return os.loadavg().map((value) => Number(value.toFixed(2)))
}

function sh(program, args) {
  try {
    return execFileSync(program, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return null
  }
}

function sysctl(name) {
  return sh('/usr/sbin/sysctl', ['-n', name])
}

export function machineInfo() {
  const power = sh('/usr/bin/pmset', ['-g', 'batt'])?.split('\n')[0] ?? null
  const lowPower = sh('/usr/bin/pmset', ['-g'])?.match(/lowpowermode\s+(\d)/)?.[1] ?? null
  return {
    model: sysctl('hw.model'),
    chip: sysctl('machdep.cpu.brand_string'),
    cores: Number(sysctl('hw.ncpu')),
    performanceCores: Number(sysctl('hw.perflevel0.physicalcpu')),
    efficiencyCores: Number(sysctl('hw.perflevel1.physicalcpu')),
    memoryGB: Number(sysctl('hw.memsize')) / 2 ** 30,
    macOS: `${sh('/usr/bin/sw_vers', ['-productVersion'])} (${sh('/usr/bin/sw_vers', ['-buildVersion'])})`,
    power: power?.replace(/^Now drawing from /, '').replace(/'/g, '') ?? null,
    lowPowerMode: lowPower === null ? null : lowPower === '1',
    node: process.version
  }
}

export function appVersion(appPath) {
  return sh('/usr/bin/plutil', [
    '-extract',
    'CFBundleShortVersionString',
    'raw',
    '-o',
    '-',
    `${appPath}/Contents/Info.plist`
  ])
}

export function commandVersion(program, args = ['--version']) {
  return sh(program, args)?.split('\n')[0] ?? null
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Waits until the 1-minute load average is at or below MAX_LOAD; throws after the timeout. */
export async function waitForQuiet() {
  const startedAt = Date.now()
  let announced = false
  for (;;) {
    const load = loadAverage()
    if (load[0] <= MAX_LOAD) {
      return { waitedMs: Date.now() - startedAt, load }
    }
    if (Date.now() - startedAt > QUIET_TIMEOUT_MS) {
      throw new Error(
        `load average stayed above ${MAX_LOAD} for ${QUIET_TIMEOUT_MS / 60_000} min (now ${load.join(' ')})`
      )
    }
    if (!announced) {
      log(`waiting for load <= ${MAX_LOAD} (now ${load.join(' ')})`)
      announced = true
    }
    await sleep(QUIET_POLL_MS)
  }
}

/** Host CPU time from procstat, to report how many cores the rest of the machine kept busy. */
export function hostCpu() {
  const out = sh(path.join(TOOLS_BIN, 'procstat'), ['--root', String(process.pid)])
  const parsed = out ? JSON.parse(out) : null
  return parsed ? { atMs: parsed.atMs, busyNs: parsed.hostBusyNs } : null
}

export function busyCoresBetween(before, after) {
  if (!before || !after || after.atMs <= before.atMs) {
    return null
  }
  return Number(((after.busyNs - before.busyNs) / ((after.atMs - before.atMs) * 1e6)).toFixed(2))
}

/**
 * Collects `count` accepted samples of `measure()` (which returns an object of numbers), after
 * `warmup` discarded ones. Each sample waits for the load gate first and records the load
 * average before and after it plus the host's busy cores during it.
 */
export async function collectSamples({ label, count, warmup = 0, measure }) {
  const samples = []
  for (let index = 0; index < warmup + count; index += 1) {
    const gate = await waitForQuiet()
    const cpuBefore = hostCpu()
    const value = await measure(index)
    const cpuAfter = hostCpu()
    const sample = {
      index,
      warmup: index < warmup,
      at: new Date().toISOString(),
      loadBefore: gate.load,
      loadAfter: loadAverage(),
      hostBusyCores: busyCoresBetween(cpuBefore, cpuAfter),
      ...value
    }
    samples.push(sample)
    if (!sample.warmup) {
      log(`${label} ${index - warmup + 1}/${count}`, JSON.stringify(value).slice(0, 160))
    }
  }
  return samples
}

/** Summaries of the named numeric fields over the accepted (non-warmup) samples. */
export function summarizeFields(samples, fields) {
  const accepted = samples.filter((sample) => !sample.warmup)
  return Object.fromEntries(
    Object.entries(fields).map(([field, unit]) => [
      field,
      summarize(
        accepted.map((sample) => sample[field]),
        unit
      )
    ])
  )
}

export function resultDir() {
  const dir =
    process.env.POD_BENCH_OUT ??
    path.join(BENCH_ROOT, 'results', new Date().toISOString().slice(0, 10))
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Writes results/<date>/<suite>.json. `metrics` are the headline rows summary.json collects:
 * { id, subject, metric, unit, better: 'lower'|'higher', stats, conditions }.
 */
export function writeSuiteResult(suite, body) {
  const file = path.join(resultDir(), `${suite}.json`)
  const result = {
    suite,
    writtenAt: new Date().toISOString(),
    machine: machineInfo(),
    maxLoad: MAX_LOAD,
    aggregation: BENCHMARK_SAMPLE_AGGREGATION,
    ...body
  }
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`)
  log(`wrote ${file}`)
  return file
}
