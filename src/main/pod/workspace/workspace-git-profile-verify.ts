// Fork-only (Pod): is the git profile Pod applied in effect? It changes no setting; timing
// `git status` may start the file watcher a repo asks for, as any status would. Timed now so the
// UI can show it against the time the apply measured.
import type { PodGitProfileRow } from '../../../shared/pod-workspace-git-profile'
import type { PodGitProfileCheck } from '../../../shared/pod-workspace-tidy-types'
import type { WorkspaceGitExec } from './workspace-git-exec'

const STATUS_RUNS = 3
/** Per run: a repo slower than this tells the user enough, and the RPC never waits a minute. */
const STATUS_TIMEOUT_MS = 5_000
const STATUS_ARGS = [
  '--no-optional-locks',
  'status',
  '--porcelain=v1',
  '--untracked-files=normal',
  '--no-renames'
]
/** The agents `git maintenance start` writes; every registered repo shares them. */
const SCHEDULER_LABELS = ['hourly', 'daily', 'weekly'].map(
  (schedule) => `org.git-scm.git.${schedule}`
)

/** Median wall time of a few `git status` runs, in ms; null when git fails. */
export async function timeGitStatus(
  git: WorkspaceGitExec,
  repoPath: string
): Promise<number | null> {
  const times: number[] = []
  for (let run = 0; run < STATUS_RUNS; run++) {
    const started = performance.now()
    const result = await git(STATUS_ARGS, repoPath, { timeoutMs: STATUS_TIMEOUT_MS })
    if (result.code !== 0) {
      return null
    }
    times.push(performance.now() - started)
  }
  times.sort((a, b) => a - b)
  return Math.round(times[Math.floor(times.length / 2)] * 10) / 10
}

export type ProfileVerifyDeps = {
  git: WorkspaceGitExec
  isRegistered: (repoPath: string) => Promise<boolean>
  /** True when launchd has this job loaded for the user (`launchctl print gui/<uid>/<label>`). */
  isLaunchdJobLoaded: (label: string) => Promise<boolean>
}

/** Every key the profile shows as in effect must still read back as that value, from any scope. */
async function keysCheck(
  git: WorkspaceGitExec,
  repoPath: string,
  rows: readonly PodGitProfileRow[]
): Promise<PodGitProfileCheck> {
  const applied = rows.filter((row) => row.action === 'keep')
  const wrong: string[] = []
  for (const row of applied) {
    const read = await git(['config', '--get', row.key], repoPath)
    if (read.code !== 0 || read.stdout.trim() !== row.value) {
      wrong.push(`${row.key}=${read.code === 0 ? read.stdout.trim() : '(unset)'}`)
    }
  }
  return wrong.length === 0
    ? { id: 'keys', ok: true, detail: `${applied.length} settings in effect` }
    : { id: 'keys', ok: false, detail: `read back differently: ${wrong.join(', ')}` }
}

export async function verifyGitProfile(
  deps: ProfileVerifyDeps,
  repoPath: string,
  rows: readonly PodGitProfileRow[]
): Promise<{ checks: PodGitProfileCheck[]; statusMs: number | null }> {
  const { git } = deps
  const checks = [await keysCheck(git, repoPath, rows)]
  // Status first: it starts the watcher when the repo asks for one.
  const statusMs = await timeGitStatus(git, repoPath)
  const fsmonitor = await git(['config', '--get', 'core.fsmonitor'], repoPath)
  if (fsmonitor.stdout.trim() === 'true') {
    const daemon = await git(['fsmonitor--daemon', 'status'], repoPath)
    checks.push({
      id: 'fsmonitor',
      ok: daemon.code === 0,
      detail: daemon.code === 0 ? 'watching this checkout' : 'no watcher is running here'
    })
  }
  const strategy = await git(['config', '--get', 'maintenance.strategy'], repoPath)
  if (strategy.code === 0) {
    const registered = await deps.isRegistered(repoPath)
    checks.push({
      id: 'maintenance',
      ok: registered,
      detail: registered ? `${strategy.stdout.trim()} maintenance registered` : 'not registered'
    })
    const loaded = await Promise.all(
      SCHEDULER_LABELS.map((label) => deps.isLaunchdJobLoaded(label))
    )
    const missing = SCHEDULER_LABELS.filter((_label, index) => !loaded[index])
    checks.push({
      id: 'scheduler',
      ok: missing.length === 0,
      detail: missing.length === 0 ? 'launchd runs it' : `not loaded: ${missing.join(', ')}`
    })
  }
  return { checks, statusMs }
}
