// The processes that belong to one run's directory, and how a cleanup stops them.
//
// A process belongs to the run when its executable (proc_pidpath) lies inside the run's dir (a
// clone of an app, a daemon the app copied into its profile) or descends from one. A process
// whose argv merely names the dir (anyone's `tail -f` of a log there, an agent's `zsh -c`) does
// not: a scan lists it as via "argv" so the run can report it, and nothing ever signals it.
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { TOOLS_BIN, sleep } from './bench-session.mjs'

const run = promisify(execFile)
export const PROCSTAT = path.join(TOOLS_BIN, 'procstat')

/**
 * The run's processes with their rusage (tools/procstat.c). `scan` adds the argv-only matches;
 * `exclude` drops the caller's own helpers. procstat itself is never listed.
 */
export async function runTree(work, { scan = false, exclude = () => false } = {}) {
  const args = ['--exe-prefix', `${work}/`]
  if (scan) args.push('--argv', `${work}/`, '--argv', `${work.replace(/^\/private/, '')}/`)
  const { stdout } = await run(PROCSTAT, args, { maxBuffer: 16 << 20 })
  const snap = JSON.parse(stdout)
  snap.procs = snap.procs.filter((proc) => proc.path !== PROCSTAT && !exclude(proc))
  return snap
}

/** The processes a cleanup may signal: the run's own tree, never the caller, never a protected program. */
export function signalTargets(procs, { protectedPrefixes = [], self = process.pid } = {}) {
  return procs.filter(
    (proc) => proc.via === 'exe' && proc.pid !== self && !protectedPrefixes.some((prefix) => proc.path.startsWith(prefix))
  )
}

/**
 * SIGTERM, then SIGKILL after half the attempts, until the run's tree is gone. Returns every signal
 * sent ({ pid, path, signal }), what was left, and the argv-only matches seen (never signalled).
 */
export async function stopRunTree(work, { protectedPrefixes = [], exclude, attempts = 50, intervalMs = 200 } = {}) {
  const signalled = []
  let left = []
  let argvOnly = []
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const snap = await runTree(work, { scan: true, exclude })
    for (const proc of snap.procs.filter((candidate) => candidate.via === 'argv')) {
      if (!argvOnly.some((seen) => seen.pid === proc.pid)) argvOnly.push({ pid: proc.pid, path: proc.path })
    }
    left = signalTargets(snap.procs, { protectedPrefixes })
    if (left.length === 0) break
    const signal = attempt < attempts / 2 ? 'SIGTERM' : 'SIGKILL'
    for (const proc of left) {
      try {
        process.kill(proc.pid, signal)
        signalled.push({ pid: proc.pid, path: proc.path, signal })
      } catch {}
    }
    await sleep(intervalMs)
  }
  return { signalled, left: left.map((proc) => ({ pid: proc.pid, path: proc.path })), argvOnly }
}
