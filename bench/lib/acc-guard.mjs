// The packaged Pod installs claude-acc when it starts (src/main/pod/acc/acc-lifecycle.ts): it runs
// the payload's setup.sh, which rewrites launchd jobs in the real gui/<uid> domain whatever HOME
// is. Every app the bench launches gets POD_ACC_LIFECYCLE=off. This guard proves nothing slipped
// through, and stops the run the moment the user's claude-acc install changes or a claude-acc
// setup.sh shows up.
//
//   node bench/lib/acc-guard.mjs --baseline FILE   record the install's state
//   node bench/lib/acc-guard.mjs --check FILE      exit 70 if it changed since
import { execFile, execFileSync } from 'node:child_process'
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** The env every app launch carries (acc-lifecycle.ts: `off` skips setup.sh entirely). */
export const ACC_OFF_ENV = Object.freeze({ POD_ACC_LIFECYCLE: 'off' })
export const TRIP_EXIT_CODE = 70
const LABEL = /^com\.filip\.claude-acc(\.[\w.-]+)?$/
const PLIST = /^com\.filip\.claude-acc.*\.plist$/
const SETUP = /claude-acc\S*\/setup\.sh(\s|$)/
// The same match in POSIX ERE for pgrep, which has no \s or \S.
const SETUP_ERE = 'claude-acc[^ ]*/setup[.]sh( |$)'
const LAUNCHCTL = process.env.POD_BENCH_LAUNCHCTL ?? '/bin/launchctl'

export function assertAccOff(env) {
  if (env.POD_ACC_LIFECYCLE !== ACC_OFF_ENV.POD_ACC_LIFECYCLE) {
    throw new Error(
      `refusing to launch without POD_ACC_LIFECYCLE=off (got ${JSON.stringify(env.POD_ACC_LIFECYCLE)}): the packaged Pod would run claude-acc's setup.sh against the user's launchd domain`
    )
  }
}

function launchctl(args) {
  return execFileSync(LAUNCHCTL, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

/** What a stray setup.sh would change: the plists, owner.json, and the jobs launchd has loaded. */
export function accState({
  home = os.homedir(),
  uid = process.getuid(),
  launchctl: query = launchctl
} = {}) {
  const agents = path.join(home, 'Library/LaunchAgents')
  const plists = {}
  for (const name of existsSync(agents) ? readdirSync(agents).sort() : []) {
    if (PLIST.test(name)) {
      const stat = statSync(path.join(agents, name))
      plists[name] = { mtimeMs: stat.mtimeMs, size: stat.size }
    }
  }
  const ownerFile = path.join(home, '.local/share/claude-acc/owner.json')
  const owner = existsSync(ownerFile) ? readFileSync(ownerFile, 'utf8') : null
  // A setup.sh under a temporary HOME bootstraps that HOME's plists: the real files keep their
  // mtimes, but the loaded job then points elsewhere. Compare what launchd runs too.
  const jobs = {}
  for (const line of query(['list']).split('\n')) {
    const label = line.split('\t')[2]?.trim()
    if (!label || !LABEL.test(label)) {
      continue
    }
    let text = ''
    try {
      text = query(['print', `gui/${uid}/${label}`])
    } catch {}
    jobs[label] = {
      path: text.match(/^\tpath = (.+)$/m)?.[1] ?? null,
      program: text.match(/^\tprogram = (.+)$/m)?.[1] ?? null,
      arguments: text.match(/^\targuments = \{\n([\s\S]*?)\n\t\}/m)?.[1]?.trim() ?? null
    }
  }
  return { plists, owner, jobs }
}

/** Human-readable differences between two accState() results; empty when nothing changed. */
export function accStateChanges(before, after) {
  const changes = []
  const names = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
  for (const name of names(before.plists, after.plists)) {
    const was = before.plists[name]
    const now = after.plists[name]
    if (!now) {
      changes.push(`${name} was removed`)
    } else if (!was) {
      changes.push(`${name} appeared`)
    } else if (now.mtimeMs !== was.mtimeMs || now.size !== was.size) {
      changes.push(`${name} was rewritten`)
    }
  }
  if (before.owner !== after.owner) {
    changes.push('claude-acc owner.json changed')
  }
  for (const label of names(before.jobs, after.jobs)) {
    const was = before.jobs[label]
    const now = after.jobs[label]
    if (!now) {
      changes.push(`launchd job ${label} was unloaded`)
    } else if (!was) {
      changes.push(`launchd job ${label} was loaded`)
    } else {
      for (const field of ['path', 'program', 'arguments']) {
        if (now[field] !== was[field]) {
          changes.push(`launchd job ${label}: ${field} changed from ${was[field]} to ${now[field]}`)
        }
      }
    }
  }
  return changes
}

/** claude-acc setup.sh processes in `ps -Ao pid=,ppid=,args=` output; `ours` if under a root pid. */
export function setupProcesses(psText, rootPids = []) {
  const rows = psText
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map(([, pid, ppid, args]) => ({ pid: Number(pid), ppid: Number(ppid), args }))
  const parentOf = new Map(rows.map((row) => [row.pid, row.ppid]))
  const roots = new Set(rootPids)
  return rows
    .filter((row) => SETUP.test(row.args))
    .map((row) => {
      let ours = false
      for (let pid = row.pid, hops = 0; pid > 1 && hops < 64; hops += 1) {
        if (roots.has(pid)) {
          ours = true
          break
        }
        pid = parentOf.get(pid) ?? 1
      }
      return { ...row, ours }
    })
}

// ---------- the guard a run uses ----------

let baseline = null
const live = new Map()
let watcher = null

function baselineState() {
  if (!baseline) {
    const file = process.env.POD_BENCH_ACC_BASELINE
    baseline = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : accState()
  }
  return baseline
}

function trip(where, problems) {
  console.error(`\n!!! claude-acc guard tripped ${where}:\n  ${problems.join('\n  ')}\n`)
  const out = process.env.POD_BENCH_OUT
  if (out && existsSync(out)) {
    writeFileSync(
      path.join(out, 'acc-guard-tripped.raw'),
      `${JSON.stringify({ at: new Date().toISOString(), where, problems }, null, 2)}\n`
    )
  }
  // Stop every instance this process launched before anything else can run.
  for (const kill of live.values()) {
    try {
      kill()
    } catch {}
  }
  process.exit(TRIP_EXIT_CODE)
}

/** Stops the run if the user's claude-acc install differs from the run's baseline. */
export function checkAcc(where) {
  const problems = accStateChanges(baselineState(), accState())
  if (problems.length > 0) {
    trip(where, problems)
  }
}

async function pollSetup() {
  let pids
  try {
    // pgrep is cheap; ps (for the parent chain) runs only when something matched.
    ;({ stdout: pids } = await run('/usr/bin/pgrep', ['-f', SETUP_ERE]))
  } catch {
    return
  }
  if (!pids.trim()) {
    return
  }
  const { stdout } = await run('/bin/ps', ['-Ao', 'pid=,ppid=,args='], {
    maxBuffer: 16 * 2 ** 20
  })
  const found = setupProcesses(stdout, [...live.keys()])
  if (found.length > 0) {
    trip(
      'while a benchmark instance was running',
      found.map(
        (row) =>
          `setup.sh pid ${row.pid} (${row.ours ? "under one of the bench's instances" : 'not under a bench instance'}): ${row.args}`
      )
    )
  }
}

/** Watches for setup.sh while the instance runs; `kill` stops it if the guard trips. */
export function guardInstance(rootPid, kill) {
  baselineState()
  live.set(rootPid, kill)
  watcher ??= setInterval(() => void pollSetup(), 1_000)
  watcher.unref?.()
}

export function releaseInstance(rootPid) {
  live.delete(rootPid)
  if (live.size === 0 && watcher) {
    clearInterval(watcher)
    watcher = null
  }
}

// realpath: Node resolves symlinks for the main module, argv[1] keeps the path as typed.
if (process.argv[1] && realpathSync(process.argv[1]) === import.meta.filename) {
  const [mode, file] = process.argv.slice(2)
  if (mode === '--baseline' && file) {
    writeFileSync(file, `${JSON.stringify(accState(), null, 2)}\n`)
  } else if (mode === '--check' && file) {
    process.env.POD_BENCH_ACC_BASELINE = file
    checkAcc('between suites')
  } else {
    console.error('usage: acc-guard.mjs --baseline FILE | --check FILE')
    process.exit(2)
  }
}
