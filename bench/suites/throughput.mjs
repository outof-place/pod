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
import { ensureLogFile, measureWorkload, workloads } from '../lib/terminal-workloads.mjs'

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

const CAVEATS = [
  'Windowless instances with background throttling off: xterm.js keeps painting, while a native view in a window that is never on screen may skip drawing. throughput-visible has the same workloads in visible windows.',
  "In Pod's native mode xterm.js still answers the device-attributes query, so wall time ends when xterm.js has parsed the output; settle time and app CPU also cover the native view's work."
]
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
          measure: () =>
            measureWorkload({
              workload: allWorkloads[workload],
              out: path.join(profile.ud, `result-${Date.now()}.json`),
              snapshot: () => processSnapshot(instance),
              start: (command) =>
                cli(instance, [
                  'terminal',
                  'send',
                  '--terminal',
                  handle,
                  '--text',
                  command,
                  '--enter'
                ])
            })
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
        branch: SUBJECTS[name].branch,
        upstream: SUBJECTS[name].upstream,
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
        branch: SUBJECTS[name].branch,
        upstream: SUBJECTS[name].upstream,
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
  caveats: CAVEATS,
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
