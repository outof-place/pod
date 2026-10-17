// The processes that belong to one run's directory, and how a cleanup stops them.
//
// A process belongs to the run when its executable (proc_pidpath) lies inside the run's dir (a
// clone of an app, a daemon the app copied into its profile), when it is one of the run's own
// spawned roots, or when it descends from either. A process whose argv merely names the dir
// (anyone's `tail -f` of a log there, an agent's `zsh -c`) does not: a scan lists it as via
// "argv" so the run can report it, and nothing signals it unless the caller's `argvOwned` says
// it is the run's by its executable too (an app copy's crashpad, which launchd adopts).
import { execFile, execFileSync } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { TOOLS_BIN, sleep } from './bench-session.mjs'

const run = promisify(execFile)
export const PROCSTAT = path.join(TOOLS_BIN, 'procstat')

// A root is { pid, startUs }: the pid a run spawned and the start time it had then.
function treeArgs(work, { scan = false, roots = [] } = {}) {
  const args = ['--exe-prefix', `${work}/`]
  for (const root of roots) args.push('--root', String(root.pid))
  if (scan) args.push('--argv', `${work}/`, '--argv', `${work.replace(/^\/private/, '')}/`)
  return args
}

function parseTree(stdout, exclude, roots = []) {
  const snap = JSON.parse(stdout)
  // A root whose pid now belongs to a later process (other start time) is not the run's, and
  // neither is anything below it: those are marked via "stale-root" and never signalled.
  const recorded = new Map(roots.map((root) => [root.pid, root.startUs]))
  const byPid = new Map(snap.procs.map((proc) => [proc.pid, proc]))
  const rootOf = (proc) => {
    let at = proc
    for (let hops = 0; at && at.inherited && hops < 64; hops += 1) at = byPid.get(at.ppid)
    return at
  }
  for (const proc of snap.procs) {
    if (proc.via !== 'root') continue
    const root = rootOf(proc)
    if (!root || recorded.get(root.pid) !== root.startUs) proc.via = 'stale-root'
  }
  snap.procs = snap.procs.filter((proc) => proc.path !== PROCSTAT && !exclude(proc))
  return snap
}

/** The record of a pid this run just spawned (for `roots`): its pid and start time. */
export function rootOfPid(pid) {
  const snap = JSON.parse(execFileSync(PROCSTAT, ['--root', String(pid)], { encoding: 'utf8', maxBuffer: 16 << 20 }))
  const proc = snap.procs.find((candidate) => candidate.pid === pid)
  if (!proc) throw new Error(`pid ${pid} is not running`)
  return { pid, startUs: proc.startUs }
}

/**
 * The run's processes with their rusage (tools/procstat.c). `scan` adds the argv-only matches;
 * `roots` are pids the run spawned itself; `exclude` drops the caller's own helpers. procstat
 * itself is never listed.
 */
export async function runTree(work, { exclude = () => false, ...options } = {}) {
  const { stdout } = await run(PROCSTAT, treeArgs(work, options), { maxBuffer: 16 << 20 })
  return parseTree(stdout, exclude, options.roots)
}

export function runTreeSync(work, { exclude = () => false, ...options } = {}) {
  return parseTree(
    execFileSync(PROCSTAT, treeArgs(work, options), { encoding: 'utf8', maxBuffer: 16 << 20 }),
    exclude,
    options.roots
  )
}

/** The processes a cleanup may signal: the run's own tree, never the caller, never a protected program. */
export function signalTargets(
  procs,
  { protectedPrefixes = [], self = process.pid, argvOwned = () => false } = {}
) {
  return procs.filter(
    (proc) =>
      (proc.via === 'exe' || proc.via === 'root' || (proc.via === 'argv' && argvOwned(proc))) &&
      proc.pid !== self &&
      !protectedPrefixes.some((prefix) => proc.path.startsWith(prefix))
  )
}

/** The start time each of these pids has right now (absent: not running). */
export function startTimes(pids) {
  if (pids.length === 0) return new Map()
  const args = pids.flatMap((pid) => ['--root', String(pid)])
  const snap = JSON.parse(execFileSync(PROCSTAT, args, { encoding: 'utf8', maxBuffer: 16 << 20 }))
  return new Map(snap.procs.map((proc) => [proc.pid, proc.startUs]))
}

function signalAll(targets, signal, signalled) {
  // Read again right before the signal: a target that exited and whose pid went to a new process
  // in between keeps its pid but not its start time.
  const now = startTimes(targets.map((proc) => proc.pid))
  for (const proc of targets) {
    if (now.get(proc.pid) !== proc.startUs) continue
    try {
      process.kill(proc.pid, signal)
      signalled.push({ pid: proc.pid, path: proc.path, signal })
    } catch {}
  }
}

function noteArgvOnly(procs, targets, argvOnly) {
  for (const proc of procs) {
    if (proc.via === 'argv' && !targets.includes(proc) && !argvOnly.some((seen) => seen.pid === proc.pid)) {
      argvOnly.push({ pid: proc.pid, path: proc.path })
    }
  }
}

/**
 * SIGTERM, then SIGKILL after half the attempts, until the run's tree is gone. Returns every signal
 * sent ({ pid, path, signal }), what was left, and the argv-only matches seen (never signalled).
 */
export async function stopRunTree(
  work,
  { protectedPrefixes = [], exclude, roots = [], argvOwned, attempts = 50, intervalMs = 200 } = {}
) {
  const signalled = []
  const argvOnly = []
  let left = []
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const snap = await runTree(work, { scan: true, exclude, roots })
    left = signalTargets(snap.procs, { protectedPrefixes, argvOwned })
    noteArgvOnly(snap.procs, left, argvOnly)
    if (left.length === 0) break
    signalAll(left, attempt < attempts / 2 ? 'SIGTERM' : 'SIGKILL', signalled)
    await sleep(intervalMs)
  }
  return { signalled, left: left.map((proc) => ({ pid: proc.pid, path: proc.path })), argvOnly }
}

/** One synchronous round of `signal` over the run's tree (for a guard that must stop it before exiting). */
export function signalRunTreeSync(work, signal, { protectedPrefixes = [], roots = [], argvOwned } = {}) {
  const snap = runTreeSync(work, { scan: true, roots })
  const targets = signalTargets(snap.procs, { protectedPrefixes, argvOwned })
  const signalled = []
  signalAll(targets, signal, signalled)
  return signalled
}
