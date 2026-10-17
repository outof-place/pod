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

function treeArgs(work, { scan = false, roots = [] } = {}) {
  const args = ['--exe-prefix', `${work}/`]
  for (const pid of roots) args.push('--root', String(pid))
  if (scan) args.push('--argv', `${work}/`, '--argv', `${work.replace(/^\/private/, '')}/`)
  return args
}

function parseTree(stdout, exclude) {
  const snap = JSON.parse(stdout)
  snap.procs = snap.procs.filter((proc) => proc.path !== PROCSTAT && !exclude(proc))
  return snap
}

/**
 * The run's processes with their rusage (tools/procstat.c). `scan` adds the argv-only matches;
 * `roots` are pids the run spawned itself; `exclude` drops the caller's own helpers. procstat
 * itself is never listed.
 */
export async function runTree(work, { exclude = () => false, ...options } = {}) {
  const { stdout } = await run(PROCSTAT, treeArgs(work, options), { maxBuffer: 16 << 20 })
  return parseTree(stdout, exclude)
}

export function runTreeSync(work, { exclude = () => false, ...options } = {}) {
  return parseTree(execFileSync(PROCSTAT, treeArgs(work, options), { encoding: 'utf8', maxBuffer: 16 << 20 }), exclude)
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

function signalAll(targets, signal, signalled) {
  for (const proc of targets) {
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
