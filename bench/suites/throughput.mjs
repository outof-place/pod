// Terminal throughput in Orca and Pod: `seq 1 3000000`, `cat` of a 100 MiB colored log, and a
// full-screen TUI repaint flood, each run by termload inside a focused terminal pane of a
// windowless instance with background throttling off (as the nt-perf spec does).
//   totalMs  producer start -> the terminal answered a device-attributes query sent after the output
//   settleMs producer start -> the app's processes went back to their idle CPU rate
//   cpuMs    CPU the app's processes (main, renderer, GPU, terminal daemon, helpers) spent meanwhile
//
//   node bench/suites/throughput.mjs [--rounds 5] [--subjects orca,pod-native,pod-xterm] [--workloads seq,cat,tui]
import { existsSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import {
  collectSamples,
  commandVersion,
  log,
  sleep,
  summarizeFields,
  waitForQuiet,
  writeSuiteResult
} from '../lib/bench-session.mjs'
import {
  SUBJECTS,
  appUsage,
  cli,
  closeInstance,
  createProfile,
  describeApp,
  launchInstance,
  loadPlaywright,
  openTerminal,
  processSnapshot,
  waitForPrompts
} from '../lib/orca-instance.mjs'
import { ensureLogFile, workloads } from '../lib/terminal-workloads.mjs'

const { values: options } = parseArgs({
  options: {
    rounds: { type: 'string', default: '5' },
    subjects: { type: 'string', default: 'orca,pod-native,pod-xterm' },
    workloads: { type: 'string', default: 'seq,cat,tui' }
  }
})
const rounds = Number(options.rounds)
const names = options.subjects.split(',')
const logFile = ensureLogFile()
const allWorkloads = workloads(logFile)
const workloadNames = options.workloads.split(',')
const IDLE_WINDOW_MS = 2_000
const SETTLE_WINDOW_MS = 300
const SETTLE_MARGIN_CORES = 0.1
const SETTLE_TIMEOUT_MS = 30_000
const RESULT_TIMEOUT_MS = 300_000

async function cpuRate(instance, ms) {
  const before = await processSnapshot(instance)
  await sleep(ms)
  const after = await processSnapshot(instance)
  return appUsage(before, after).cpuMs / (after.atMs - before.atMs)
}

async function runWorkload(instance, handle, workload) {
  const out = path.join(instance.profile.ud, `result-${Date.now()}.json`)
  const idleCores = await cpuRate(instance, IDLE_WINDOW_MS)
  const before = await processSnapshot(instance)
  await cli(instance, [
    'terminal',
    'send',
    '--terminal',
    handle,
    '--text',
    workload.command(out),
    '--enter'
  ])
  const deadline = Date.now() + RESULT_TIMEOUT_MS
  while (!existsSync(out)) {
    if (Date.now() > deadline) {
      throw new Error(`no result for ${workload.label}`)
    }
    await sleep(20)
  }
  const result = JSON.parse(readFileSync(out, 'utf8'))
  rmSync(out)
  // Settled: the app's CPU rate over the last window is back near its idle rate.
  let previous = await processSnapshot(instance)
  let settledAtMs = null
  const settleDeadline = Date.now() + SETTLE_TIMEOUT_MS
  while (Date.now() < settleDeadline) {
    await sleep(SETTLE_WINDOW_MS)
    const current = await processSnapshot(instance)
    const cores = appUsage(previous, current).cpuMs / (current.atMs - previous.atMs)
    previous = current
    if (cores <= idleCores + SETTLE_MARGIN_CORES) {
      settledAtMs = current.atMs - SETTLE_WINDOW_MS
      break
    }
  }
  const usage = appUsage(before, previous)
  const bytes = workload.bytes ?? result.bytes
  return {
    synced: result.synced,
    daReply: result.daReply,
    cols: result.cols,
    rows: result.rows,
    producerMs: result.producerMs,
    totalMs: result.totalMs,
    settleMs: settledAtMs === null ? null : settledAtMs - result.startedAtMs,
    mibPerS: bytes / 2 ** 20 / (result.totalMs / 1000),
    cpuMs: usage.cpuMs,
    cpuByRole: Object.fromEntries(
      Object.entries(usage.byRole).map(([role, value]) => [role, Number(value.cpuMs.toFixed(1))])
    ),
    idleCores: Number(idleCores.toFixed(3))
  }
}

// A pane can report a tiny PTY size until its view is laid out (seen once at 2x1 in Pod native).
async function waitForGeometry(instance, handle) {
  const out = path.join(instance.profile.ud, 'geometry')
  const deadline = Date.now() + 60_000
  for (;;) {
    rmSync(out, { force: true })
    await cli(instance, [
      'terminal',
      'send',
      '--terminal',
      handle,
      '--text',
      `stty size > '${out}'`,
      '--enter'
    ])
    for (let i = 0; i < 100 && !existsSync(out); i += 1) {
      await sleep(20)
    }
    const [rows, cols] = existsSync(out)
      ? readFileSync(out, 'utf8').trim().split(/\s+/).map(Number)
      : [0, 0]
    if (cols >= 80 && rows >= 24) {
      return { cols, rows }
    }
    if (Date.now() > deadline) {
      throw new Error(`pane stayed ${cols}x${rows}`)
    }
    await sleep(500)
  }
}

const samples = {}
for (const name of names) {
  for (const workload of workloadNames) {
    samples[`${name}.${workload}`] = []
  }
} // Round 0 is a warm-up for every subject and workload; rounds rotate subject and workload order.
for (let round = 0; round <= rounds; round += 1) {
  const order = names.map((_, i) => names[(i + round) % names.length])
  for (const name of order) {
    await waitForQuiet()
    const subject = SUBJECTS[name]
    const profile = createProfile({
      experimentalNativeTerminal: subject.nativeTerminal,
      terminalCursorBlink: false
    })
    const instance = await launchInstance(subject.app, profile)
    try {
      const handle = await openTerminal(instance)
      await waitForPrompts(profile, 1)
      await waitForGeometry(instance, handle)
      await sleep(3_000)
      const workloadOrder = workloadNames.map(
        (_, i) => workloadNames[(i + round) % workloadNames.length]
      )
      for (const workload of workloadOrder) {
        const [sample] = await collectSamples({
          label: `throughput ${name} ${workload} round ${round}`,
          count: round === 0 ? 0 : 1,
          warmup: round === 0 ? 1 : 0,
          measure: () => runWorkload(instance, handle, allWorkloads[workload])
        })
        samples[`${name}.${workload}`].push({ ...sample, index: round })
      }
    } finally {
      await closeInstance(instance)
    }
  }
}

const metrics = []
const versions = {
  playwrightCore: loadPlaywright().version,
  seq: commandVersion('/usr/bin/seq', ['--version']) ?? '/usr/bin/seq (macOS)'
}
for (const name of names) {
  versions[name] = describeApp(SUBJECTS[name].app)
  for (const workload of workloadNames) {
    // A sample whose pane was not laid out yet ran on a different grid; it does not count.
    const rows = samples[`${name}.${workload}`].filter((row) => row.cols >= 80 && row.rows >= 24)
    const stats = summarizeFields(rows, {
      totalMs: 'ms',
      settleMs: 'ms',
      cpuMs: 'ms',
      mibPerS: 'MiB/s'
    })
    const grid = rows.find((row) => !row.warmup)
    const conditions = `windowless instance, background throttling off, 1 focused pane ${grid?.cols}x${grid?.rows}, cursor blink off`
    metrics.push(
      {
        id: `throughput.${workload}.wall.${name}`,
        subject: SUBJECTS[name].label,
        metric: `${allWorkloads[workload].label}: wall time`,
        unit: 'ms',
        better: 'lower',
        stats: stats.totalMs,
        extra: { settleMs: stats.settleMs, mibPerS: stats.mibPerS },
        conditions
      },
      {
        id: `throughput.${workload}.cpu.${name}`,
        subject: SUBJECTS[name].label,
        metric: `${allWorkloads[workload].label}: app CPU time`,
        unit: 'ms',
        better: 'lower',
        stats: stats.cpuMs,
        conditions
      }
    )
  }
}
log('done')
writeSuiteResult('throughput', {
  versions,
  config: {
    rounds,
    subjects: names,
    workloads: Object.fromEntries(workloadNames.map((name) => [name, allWorkloads[name].label])),
    logFile
  },
  metrics,
  samples
})
