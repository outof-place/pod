// Process polling: the reads behind Orca's per-pane "who holds this terminal" check
// (src/main/runtime/terminal-foreground-group.ts), forking /bin/ps as Orca 1.4.223 does vs
// reading the kernel's process table with sysctl.
//
//   node bench/suites/polling.mjs [--runs 7] [--calls 100]
import { execFile, execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { promisify } from 'node:util'
import {
  TOOLS_BIN,
  collectSamples,
  commandVersion,
  log,
  sleep,
  writeSuiteResult
} from '../lib/bench-session.mjs'
import { summarize } from '../lib/sample-stats.mjs'

const { values: options } = parseArgs({
  options: { runs: { type: 'string', default: '7' }, calls: { type: 'string', default: '100' } }
})
const runs = Number(options.runs)
const calls = Number(options.calls)
const run = promisify(execFile)

// A pane-like terminal: a shell holding the pty with two children, as `login -> zsh -> agent`.
const holder = spawn(
  '/usr/bin/script',
  ['-q', '/dev/null', '/bin/zsh', '-fc', 'sleep 86400 & sleep 86400 & wait'],
  {
    stdio: 'ignore'
  }
)
// The load gate can wait for hours; never leave the pty behind.
const stopHolder = () => {
  try {
    execFileSync('/usr/bin/pkill', ['-TERM', '-g', String(holder.pid)])
  } catch {}
  holder.kill('SIGTERM')
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

// Optional: the work-in-progress Pod addon (native/proc-info-darwin), when built locally.
const addonPath =
  process.env.POD_BENCH_PROC_INFO_ADDON ??
  path.join(
    os.homedir(),
    'Documents/orca-native-wt/proc-info-darwin/native/proc-info-darwin/.build/release/orca-proc-info.node'
  )
let addon = null
if (existsSync(addonPath)) {
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
  ...(addon
    ? {
        'addon-read-process': async () => ({ us: addonCalls(() => addon.readProcess(rootPid)) }),
        'addon-list-terminal': async () => ({
          us: addonCalls(() => addon.listTerminalProcesses(tty))
        })
      }
    : {})
}

const perCall = Object.fromEntries(Object.keys(methods).map((name) => [name, []]))
const correctness = {}
const samples = await collectSamples({
  label: 'polling',
  count: runs,
  warmup: 1,
  measure: async (index) => {
    const row = {}
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
  'addon-read-process': ['Pod proc-info addon (WIP) readProcess(pid) from Node', 'terminal lookup'],
  'addon-list-terminal': [
    'Pod proc-info addon (WIP) listTerminalProcesses(tty) from Node',
    'terminal process rows'
  ]
}
const metrics = Object.keys(methods).map((name) => ({
  id: `polling.${name}`,
  subject: subjects[name][0],
  metric: `${subjects[name][1]} per call`,
  unit: 'µs',
  better: 'lower',
  stats: summarize(perCall[name], 'µs'),
  conditions: `${runs} runs x ${calls} calls, plain Node ${process.version}, pty with 3 processes`
}))

const comparisons = [
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
  ...(addon
    ? [
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

writeSuiteResult('polling', {
  comparisons,
  versions: {
    ps: '/bin/ps (macOS, setuid root)',
    addon: addon
      ? {
          path: addonPath,
          sha256: createHash('sha256').update(readFileSync(addonPath)).digest('hex'),
          note: 'uncommitted work in progress'
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
