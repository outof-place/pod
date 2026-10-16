// Process polling: the reads behind Orca's per-pane "who holds this terminal" check
// (src/main/runtime/terminal-foreground-group.ts), forking /bin/ps as Orca does vs
// reading the kernel's process table with sysctl.
//
//   node bench/suites/polling.mjs [--runs 7] [--calls 100]
import { execFile, execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { promisify } from 'node:util'
import {
  TOOLS_BIN,
  appVersion,
  collectSamples,
  commandVersion,
  log,
  sleep,
  writeSuiteResult
} from '../lib/bench-session.mjs'
import { ORCA_APP, POD_APP } from '../lib/orca-instance.mjs'
import { summarize } from '../lib/sample-stats.mjs'

const { values: options } = parseArgs({
  options: {
    runs: { type: 'string', default: '7' },
    calls: { type: 'string', default: '100' },
    'extra-ptys': { type: 'string', default: '0' }
  }
})
const runs = Number(options.runs)
const calls = Number(options.calls)
const extraPtys = Number(options['extra-ptys'])
// ps' tty= column pays one /dev scan per tty-bearing row, so its cost follows the number of open
// terminals: --extra-ptys adds idle ptys, as an agent fleet keeps open, in a suite of its own.
const SUITE = extraPtys > 0 ? `polling-ptys${extraPtys}` : 'polling'
const run = promisify(execFile)

// The runtime-scope rows cite each app's source at these builds only (RUNTIME_SOURCES below): a
// run on any other build stops here, before measuring, instead of citing another version's code.
const CITED_BUILDS = {
  orca: { version: '1.4.227', commit: '7c19f712f7' },
  pod: { version: '1.0.0-rc3', commit: '795854fc00' }
}
if (process.env.POD_BENCH_SCOPE === 'runtime') {
  for (const [app, bundle] of [
    ['orca', ORCA_APP],
    ['pod', POD_APP]
  ]) {
    // The version and the commit the bundle records (orca-local-build.json): a local rebuild
    // carrying the same version string still stops here.
    let commit = null
    try {
      commit = JSON.parse(
        readFileSync(path.join(realpathSync(bundle), 'Contents/Resources/orca-local-build.json'), 'utf8')
      ).commit
    } catch {}
    const benched = { version: appVersion(bundle), commit }
    const cited = CITED_BUILDS[app]
    if (benched.version !== cited.version || !benched.commit?.startsWith(cited.commit)) {
      throw new Error(
        `the polling sources cite ${app} ${cited.version} (${cited.commit}), this run benches ${benched.version} (${benched.commit}): re-check them first`
      )
    }
  }
}

// A pane-like terminal: a shell holding the pty with two children, as `login -> zsh -> agent`.
const holder = spawn(
  '/usr/bin/script',
  ['-q', '/dev/null', '/bin/zsh', '-fc', 'sleep 86400 & sleep 86400 & wait'],
  {
    stdio: 'ignore'
  }
)
const extraHolders = Array.from({ length: extraPtys }, () =>
  spawn('/usr/bin/script', ['-q', '/dev/null', '/bin/sleep', '86400'], { stdio: 'ignore' })
)
// Every process under one of this run's own children (a pgrep -P walk), deepest first.
function descendants(pid) {
  let children = []
  try {
    children = execFileSync('/usr/bin/pgrep', ['-P', String(pid)], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map(Number)
  } catch {}
  return children.flatMap((child) => [...descendants(child), child])
}
// The load gate can wait for hours; never leave the ptys behind.
const stopHolder = () => {
  for (const child of [holder, ...extraHolders]) {
    for (const pid of descendants(child.pid)) {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {}
    }
    child.kill('SIGTERM')
  }
}
process.on('exit', stopHolder)
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => process.exit(130))
}
await sleep(1_000)
const { stdout: children } = await run('/usr/bin/pgrep', ['-P', String(holder.pid)])
const rootPid = Number(children.trim().split('\n')[0])
const { stdout: ttyOut } = await run('/bin/ps', ['-o', 'tty=', '-p', String(rootPid)])
const tty = ttyOut.trim()
log(`pane-like terminal: root pid ${rootPid} on ${tty}`)

async function probe(mode) {
  const { stdout } = await run(path.join(TOOLS_BIN, 'ttyprobe'), [
    '--pid',
    String(rootPid),
    '--mode',
    mode,
    '--iterations',
    String(calls)
  ])
  return JSON.parse(stdout)
}

// Orca forks ps from Node (runProcess); time the same call from Node.
async function nodePs(args) {
  const us = []
  for (let i = 0; i < calls; i += 1) {
    const t0 = process.hrtime.bigint()
    await run('/bin/ps', args)
    us.push(Number(process.hrtime.bigint() - t0) / 1e3)
  }
  return us
}

// Pod's process-info addon (native/proc-info-darwin): the one in the Pod build under test, else
// a local development build of it.
const podAddon = path.join(realpathSync(POD_APP), 'Contents/Resources/native/orca-proc-info.node')
const devAddon = path.join(
  os.homedir(),
  'Documents/orca-native-wt/proc-info-darwin/native/proc-info-darwin/.build/release/orca-proc-info.node'
)
const addonPath =
  process.env.POD_BENCH_PROC_INFO_ADDON ?? [podAddon, devAddon].find((file) => existsSync(file))
const addonSource =
  addonPath === podAddon ? `the Pod build (${POD_APP})` : 'a local development build'
// The final run publishes the addon as the benched Pod's: never a development build in its place.
if (process.env.POD_BENCH_REQUIRE_POD_ADDON === '1' && addonPath !== podAddon) {
  throw new Error(`the Pod build has no ${path.relative(realpathSync(POD_APP), podAddon)}`)
}
let addon = null
if (addonPath && existsSync(addonPath)) {
  try {
    const module = { exports: {} }
    process.dlopen(module, addonPath)
    addon = module.exports
  } catch (error) {
    log(`addon not loadable from node: ${error.message}`)
  }
}

function addonCalls(fn) {
  const us = []
  for (let i = 0; i < calls; i += 1) {
    const t0 = process.hrtime.bigint()
    fn()
    us.push(Number(process.hrtime.bigint() - t0) / 1e3)
  }
  return us
}

const methods = {
  'c-ps-tty': () => probe('ps-tty'),
  'c-ps-rows': () => probe('ps-rows'),
  'c-sysctl-tty': () => probe('sysctl-tty'),
  'c-sysctl-rows': () => probe('sysctl-rows'),
  'node-ps-tty': async () => ({ us: await nodePs(['-o', 'tty=', '-p', String(rootPid)]) }),
  'node-ps-rows': async () => ({
    us: await nodePs(['-o', 'pid=,ppid=,pgid=,tpgid=,stat=,command=', '-t', tty])
  }),
  // The whole process table, as Orca's daemon reads it about once a second (PS_ARGS).
  'c-ps-all': () => probe('ps-all'),
  'c-ps-cheap': () => probe('ps-cheap'),
  'c-ps-notty': () => probe('ps-notty'),
  'c-ps-ttyonly': () => probe('ps-ttyonly'),
  'c-ps-pidonly': () => probe('ps-pidonly'),
  'c-sysctl-all': () => probe('sysctl-all'),
  'node-ps-all': async () => ({
    us: await nodePs(['-axo', 'pid=,ppid=,pgid=,tpgid=,stat=,tty=,lstart=,command='])
  }),
  // Orca's cheap tier (CHEAP_PS_ARGS) from Node: what Pod's listProcesses() replaces.
  'node-ps-cheap': async () => ({
    us: await nodePs(['-axo', 'pid=,ppid=,pgid=,tpgid=,stat=,lstart='])
  }),
  ...(addon
    ? {
        'addon-read-process': async () => ({ us: addonCalls(() => addon.readProcess(rootPid)) }),
        'addon-list-terminal': async () => ({
          us: addonCalls(() => addon.listTerminalProcesses(tty))
        }),
        'addon-list-processes': async () => ({ us: addonCalls(() => addon.listProcesses()) })
      }
    : {})
}

// run-final.sh --runtime-only: only the reads Pod's runtime makes, against the ps forks Orca makes
// for the same reads. Pod 1.0 reads a pane's terminal rows with listTerminalProcesses(tty) on every
// poll and the cheap process table with listProcesses(); its terminal lookup is once per pane and
// falls back to ps on a cold tty-name cache, and the full table still forks ps, so those rows and
// the reference C implementations (ttyprobe) are left out.
const RUNTIME_METHODS = ['node-ps-rows', 'addon-list-terminal', 'node-ps-cheap', 'addon-list-processes']
if (process.env.POD_BENCH_SCOPE === 'runtime') {
  if (!addon) {
    throw new Error('--runtime-only needs the Pod build\'s proc-info addon')
  }
  for (const name of Object.keys(methods)) {
    if (!RUNTIME_METHODS.includes(name)) {
      delete methods[name]
    }
  }
}
const perCall = Object.fromEntries(Object.keys(methods).map((name) => [name, []]))
const correctness = {}
const samples = await collectSamples({
  label: 'polling',
  count: runs,
  warmup: 1,
  measure: async (index) => {
    // What the tty= column's cost depends on, recorded with every sample.
    const { stdout: ttys } = await run('/bin/ps', ['-axo', 'tty='], { maxBuffer: 16 * 1024 * 1024 })
    const rows = ttys.split('\n').filter(Boolean)
    const row = {
      processes: rows.length,
      ttyProcesses: rows.filter((tty) => !tty.trim().startsWith('?')).length
    }
    // Rotate the order so no method always runs first after the gate.
    const names = Object.keys(methods)
    const order = names.map((_, i) => names[(i + index) % names.length])
    for (const name of order) {
      const result = await methods[name]()
      if (result.tty) {
        correctness[name] = { tty: result.tty, rows: result.rows }
      }
      row[`${name}MedianUs`] = summarize(result.us, 'µs').median
      if (index > 0) {
        perCall[name].push(...result.us)
      }
    }
    return row
  }
})
stopHolder()

function medianOf(rows, field) {
  return summarize(
    rows.filter((row) => !row.warmup).map((row) => row[field]),
    'count'
  )?.median
}

const subjects = {
  'c-ps-tty': ['Orca 1.4.223 way: fork `ps -o tty= -p PID` (C posix_spawn)', 'terminal lookup'],
  'c-sysctl-tty': ['sysctl KERN_PROC_PID + devname (C)', 'terminal lookup'],
  'c-ps-rows': [
    'Orca 1.4.223 way: fork `ps -o pid=,ppid=,pgid=,tpgid=,stat=,command= -t TTY` (C posix_spawn)',
    'terminal process rows'
  ],
  'c-sysctl-rows': [
    'sysctl KERN_PROC_TTY + KERN_PROCARGS2 per process (C)',
    'terminal process rows'
  ],
  'node-ps-tty': ['Orca 1.4.223 way from Node: execFile `ps -o tty= -p PID`', 'terminal lookup'],
  'node-ps-rows': ['Orca 1.4.223 way from Node: execFile `ps ... -t TTY`', 'terminal process rows'],
  'c-ps-all': [
    'Orca 1.4.223 way: fork `ps -axo pid=,ppid=,pgid=,tpgid=,stat=,tty=,lstart=,command=` (C posix_spawn)',
    'whole process table (PS_ARGS)'
  ],
  'c-ps-notty': [
    '`ps -axo` with PS_ARGS minus tty= (C posix_spawn)',
    'whole process table, no tty column'
  ],
  'c-ps-ttyonly': ['`ps -axo pid=,tty=` (C posix_spawn)', 'whole process table, tty column only'],
  'c-ps-pidonly': ['`ps -axo pid=` (C posix_spawn)', 'whole process table, pid only'],
  'c-ps-cheap': [
    'Orca 1.4.223 cheap tier: fork `ps -axo pid=,ppid=,pgid=,tpgid=,stat=,lstart=` (C posix_spawn)',
    'whole process table, no tty or command'
  ],
  'c-sysctl-all': [
    'sysctl KERN_PROC_ALL + KERN_PROCARGS2 per process + devname cached per device (C)',
    'whole process table (PS_ARGS)'
  ],
  'node-ps-all': [
    'Orca 1.4.223 way from Node: execFile `ps -axo ...` (PS_ARGS)',
    'whole process table (PS_ARGS)'
  ],
  'node-ps-cheap': [
    'Orca 1.4.223 cheap tier from Node: execFile `ps -axo pid=,ppid=,pgid=,tpgid=,stat=,lstart=`',
    'cheap process table (no tty or command)'
  ],
  'addon-read-process': ['Pod proc-info addon: readProcess(pid) from Node', 'terminal lookup'],
  'addon-list-terminal': [
    'Pod proc-info addon: listTerminalProcesses(tty) from Node',
    'terminal process rows'
  ],
  'addon-list-processes': [
    'Pod proc-info addon: listProcesses() from Node',
    process.env.POD_BENCH_SCOPE === 'runtime'
      ? 'cheap process table (no tty or command)'
      : 'whole process table (PS_ARGS)'
  ]
}
const metrics = Object.keys(methods).map((name) => ({
  id: `${SUITE}.${name}`,
  // The labels name the Orca release the run compared against (run-final.sh checks it still forks ps).
  subject: subjects[name][0].replace('Orca 1.4.223', `Orca ${appVersion(ORCA_APP)}`),
  metric: `${subjects[name][1]} per call`,
  unit: 'µs',
  better: 'lower',
  stats: summarize(perCall[name], 'µs'),
  conditions: `${runs} runs x ${calls} calls, plain Node ${process.version}, ${medianOf(samples, 'processes')} processes, ${medianOf(samples, 'ttyProcesses')} on a tty${extraPtys > 0 ? ` (${extraPtys} idle ptys added)` : ''}`,
  ...(name.startsWith('addon-')
    ? {
        branch: 'perf/native-proc-info-darwin',
        upstream: 'https://github.com/stablyai/orca/pull/26985'
      }
    : {}),
  ...(name.startsWith('c-sysctl')
    ? {
        caveats: [
          'A reference C implementation in bench/tools/ttyprobe.c, not code that ships in Pod.'
        ]
      }
    : {}),
  ...(name === 'addon-list-processes' && process.env.POD_BENCH_SCOPE === 'runtime'
    ? {
        caveats: [
          "Pod's runtime makes this call on a worker thread; the row times the addon call itself, without the worker message."
        ]
      }
    : {})
}))

const RUNTIME_COMPARISONS = [
  {
    baseline: 'polling.node-ps-rows',
    candidate: 'polling.addon-list-terminal',
    label: 'terminal process rows, every poll: Orca forks ps vs Pod addon'
  },
  {
    baseline: 'polling.node-ps-cheap',
    candidate: 'polling.addon-list-processes',
    label: 'cheap process table: Orca forks ps vs Pod addon'
  }
]
const fullComparisons = [
  {
    baseline: 'polling.c-ps-tty',
    candidate: 'polling.c-sysctl-tty',
    label: 'terminal lookup: fork ps vs sysctl (C)'
  },
  {
    baseline: 'polling.c-ps-rows',
    candidate: 'polling.c-sysctl-rows',
    label: 'terminal process rows: fork ps vs sysctl (C)'
  },
  {
    baseline: 'polling.c-ps-all',
    candidate: 'polling.c-sysctl-all',
    label: 'whole process table: fork ps vs sysctl (C)'
  },
  ...(addon
    ? [
        {
          baseline: 'polling.node-ps-all',
          candidate: 'polling.addon-list-processes',
          label: 'whole process table from Node: execFile ps vs Pod addon'
        },
        {
          baseline: 'polling.node-ps-tty',
          candidate: 'polling.addon-read-process',
          label: 'terminal lookup from Node: execFile ps vs addon'
        },
        {
          baseline: 'polling.node-ps-rows',
          candidate: 'polling.addon-list-terminal',
          label: 'terminal process rows from Node: execFile ps vs addon'
        }
      ]
    : [])
]
const comparisons = process.env.POD_BENCH_SCOPE === 'runtime' ? RUNTIME_COMPARISONS : fullComparisons

// Where each runtime-scope row comes from: the same read in both apps, at the same frequency.
const RUNTIME_SOURCES = [
  `Terminal process rows, every poll. Orca ${CITED_BUILDS.orca.version}: src/main/runtime/terminal-foreground-group.ts:56 runs \`ps -o pid=,ppid=,pgid=,tpgid=,stat=,command= -t TTY\` through runProcess (a Node spawn); the tty is cached per pane root pid (:15-48). Pod ${CITED_BUILDS.pod.version} (${CITED_BUILDS.pod.commit}): the same file, :72, calls listTerminalProcesses(tty) with the same per-pane tty cache (:18-36). The Orca row runs the same ps arguments from Node with execFile, without runProcess's PATH lookup.`,
  `Cheap process table. Orca ${CITED_BUILDS.orca.version}: src/shared/cheap-process-table-snapshot-reader.ts:20-27 forks \`ps\` with CHEAP_PS_ARGS (src/shared/process-table-snapshot.ts:35-39, \`-axo pid=,ppid=,pgid=,tpgid=,stat=,lstart=\` on macOS) inside the shared reader's coalescing and TTL. Pod ${CITED_BUILDS.pod.version}: the same reader (:22-24) asks listProcesses() first (:51-57) and keeps ps as the fallback, with the same coalescing and TTL, so both rows time one capture each.`,
  `The Orca ${CITED_BUILDS.orca.version} bundle records commit ${CITED_BUILDS.orca.commit}, 2 commits behind the v${CITED_BUILDS.orca.version} tag's commit f51e82c4c2; the source files these rows cite are identical at both.`
]
writeSuiteResult(SUITE, {
  // ps' tty= cost follows the open terminals: label which machine state each suite stands for.
  condition: extraPtys > 0 ? 'agent-heavy' : 'quiet',
  caveats: [
    ...(process.env.POD_BENCH_SCOPE === 'runtime' ? RUNTIME_SOURCES : []),
    extraPtys > 0
      ? `Agent-heavy: ${extraPtys} idle ptys added to the quiet window, about the number of terminals this Mac keeps open in normal agent work. This is the condition that matches daily use.`
      : 'Quiet window: agents parked and few terminals open, so ps has few tty rows to resolve. polling-ptys80 is the agent-heavy condition.'
  ],
  comparisons: comparisons.map((pair) => ({
    ...pair,
    baseline: pair.baseline.replace(/^polling\./, `${SUITE}.`),
    candidate: pair.candidate.replace(/^polling\./, `${SUITE}.`)
  })),
  versions: {
    ps: '/bin/ps (macOS, setuid root)',
    addon: addon
      ? {
          path: addonPath,
          sha256: createHash('sha256').update(readFileSync(addonPath)).digest('hex'),
          source: addonSource
        }
      : null,
    zsh: commandVersion('/bin/zsh', ['--version'])
  },
  config: { runs, calls, rootPid, tty },
  correctness,
  metrics,
  samples,
  perCallUs: perCall
})
