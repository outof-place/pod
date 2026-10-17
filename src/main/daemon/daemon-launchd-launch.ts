// Fork-only (Pod): the macOS daemon as a launchd job in the user's GUI domain
// (POD_DAEMON_LAUNCHD=1). A job leads its own coalition for its whole life, and launchservicesd
// gives an app exec'd into a coalition with a live leader no coalition of its own. A forked daemon
// sits in the runtime's coalition, which loses its leader when the runtime quits; an app started
// from a terminal could then own it, and its quit or Force Quit ends every session (M10).
import { readFileSync, unlinkSync } from 'node:fs'
import type { ProcessResult } from '@orca/process-host/process-spec'
import { runLaunchctl } from '../pod/launchd/launchctl-darwin'
import { daemonAppPolicyLaunch, daemonNodeExecutable } from './daemon-app-scheduling-policy'
import {
  buildDaemonChildEnv,
  buildDaemonScriptArgs,
  type DaemonChildSpawnOptions
} from './daemon-launched-child-spawn'
import {
  DAEMON_LAUNCHD_REPORT_ARG,
  keepParentCheckedEnv,
  readDaemonLaunchdReport
} from './daemon-launchd-report'
import { parseDaemonReadyIdentity, type DaemonReadyIdentity } from './daemon-ready-identity'
import { DAEMON_EXIT_ENDPOINT_OCCUPIED } from './daemon-endpoint-ownership'
import {
  LaunchdDaemonProcess,
  processIsAlive,
  warnLaunchdFailure,
  type DaemonLaunchdJobControl
} from './daemon-launchd-process'

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000
const REPORT_POLL_MS = 25
const PRINT_POLL_MS = 500
// Why short: it lands in an error message and runtime-stderr.log.
const STDERR_TAIL_BYTES = 2048
// The daemon's SIGTERM budget (daemon-entry SHUTDOWN_TIMEOUT_MS, 5 s) plus its reply flush (1 s)
// and a second of slack, before launchd's SIGKILL.
const DAEMON_EXIT_TIMEOUT_S = 7
// launchd's default soft NOFILE for a job is 256; a daemon holds several descriptors per PTY.
const DAEMON_NUMBER_OF_FILES = 10_240

export function isLaunchdDaemonLaunchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  // Why opt-in (POD_DAEMON_LAUNCHD=1) for now: on by default only once a package's TCC check shows
  // the job's shells keep Pod's grants (r-orca). Off under vitest too: no real jobs from unit tests.
  return process.platform === 'darwin' && env.POD_DAEMON_LAUNCHD === '1'
}

/** A GUI session's daemon wants a job: a plain serve forks (SSH must outlive the session), but
 *  PodNative's headless runtime is a serve of the GUI session. */
export function isGuiSessionDaemon(
  isServeMode: boolean,
  isPodHeadlessUiHost: boolean,
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform === 'darwin' && (!isServeMode || isPodHeadlessUiHost)
}

/** Where one launch's job lives (daemon-host side): its label and files. */
export type DaemonLaunchdPaths = {
  label: string
  plistPath: string
  reportPath: string
  stdoutPath: string
  stderrPath: string
}

export type DaemonLaunchdJob = {
  program: string
  args: string[]
  env: NodeJS.ProcessEnv
  cwd: string
  /** ExitTimeOut: seconds between launchd's SIGTERM and its SIGKILL. */
  exitTimeoutSeconds: number
  /** SoftResourceLimits.NumberOfFiles. */
  numberOfFiles: number
}

/** The daemon-host side of a launchd launch: naming, the plist, and removing a job by label. */
export type DaemonLaunchdJobs = DaemonLaunchdJobControl & {
  paths(options: { userDataPath: string; launchNonce: string }): DaemonLaunchdPaths
  writePlist(paths: DaemonLaunchdPaths, job: DaemonLaunchdJob): void
}

export type RunLaunchctl = (args: string[]) => Promise<ProcessResult>

export type DaemonLaunchdOutcome =
  | { kind: 'ready'; child: LaunchdDaemonProcess; identity: DaemonReadyIdentity }
  | { kind: 'endpoint-unavailable'; reason: string }

function removeQuietly(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // Already gone.
  }
}

/** What launchd says of a job: its pid while it runs, the exit code of its last run. */
async function printJob(
  launchctl: RunLaunchctl,
  uid: number,
  label: string
): Promise<{ pid: number | null; lastExitCode: number | null }> {
  const printed = await launchctl(['print', `gui/${uid}/${label}`]).catch(() => null)
  const text = printed?.code === 0 ? printed.stdout : ''
  const pid = /^\s*pid = (\d+)$/m.exec(text)
  const last = /^\s*last exit code = (-?\d+)$/m.exec(text)
  return { pid: pid ? Number(pid[1]) : null, lastExitCode: last ? Number(last[1]) : null }
}

function stderrTail(path: string): string {
  try {
    return readFileSync(path, 'utf8').slice(-STDERR_TAIL_BYTES).trim()
  } catch {
    return ''
  }
}

/**
 * Boots the daemon out as a job (`launchctl bootstrap gui/<uid>`) and waits for its report, the
 * stand-in for the forked daemon's IPC messages. Throws on anything but a ready daemon or a lost
 * endpoint race, with the job booted out, so the caller can fork instead.
 */
export async function launchDaemonViaLaunchd(
  options: DaemonChildSpawnOptions,
  jobs: DaemonLaunchdJobs,
  launchctl: RunLaunchctl = runLaunchctl
): Promise<DaemonLaunchdOutcome> {
  // Why the clone only: an update deletes the bundle, and a job outlives the runtime that made it.
  const executable = options.relocatedExecPath
    ? daemonNodeExecutable(options.relocatedExecPath)
    : null
  const uid = process.getuid?.()
  if (!executable || uid === undefined) {
    throw new Error('a launchd daemon needs its daemon-host clone and a user')
  }
  const paths = jobs.paths({ userDataPath: options.userDataPath, launchNonce: options.launchNonce })
  removeQuietly(paths.reportPath)
  // Why the daemon's own executable: a job is its own TCC responsible process, not its spawner.
  const scriptArgs = [
    ...buildDaemonScriptArgs(options, executable),
    DAEMON_LAUNCHD_REPORT_ARG,
    paths.reportPath
  ]
  // Same app scheduling policy as a fork; taskpolicy execs in place, so the job's pid stays leader.
  const launch = daemonAppPolicyLaunch(options.forkEntryPath, scriptArgs, executable) ?? {
    program: executable,
    args: [options.forkEntryPath, ...scriptArgs]
  }
  jobs.writePlist(paths, {
    program: launch.program,
    args: launch.args,
    env: keepParentCheckedEnv(buildDaemonChildEnv(options)),
    cwd: options.userDataPath,
    exitTimeoutSeconds: DAEMON_EXIT_TIMEOUT_S,
    numberOfFiles: DAEMON_NUMBER_OF_FILES
  })
  let bootstrap: ProcessResult
  try {
    bootstrap = await launchctl(['bootstrap', `gui/${uid}`, paths.plistPath])
  } finally {
    // Why: launchd keeps its own copy, and this one holds the daemon's environment.
    removeQuietly(paths.plistPath)
  }
  const fail = async (message: string): Promise<never> => {
    // Why bootout and not a kill: it stops the job's process too, and unloads the job.
    await jobs.bootout(paths.label).catch(warnLaunchdFailure('bootout'))
    removeQuietly(paths.reportPath)
    const tail = stderrTail(paths.stderrPath)
    throw new Error(tail ? `${message}\nDaemon stderr (tail):\n${tail}` : message)
  }
  if (bootstrap.code !== 0) {
    return fail(`launchctl bootstrap exited ${bootstrap.code}: ${bootstrap.stderr.trim()}`)
  }
  const deadline = Date.now() + (options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS)
  // Why launchd's own view too: a daemon that dies before its first report leaves only that.
  let pid: number | null = (await printJob(launchctl, uid, paths.label)).pid
  let printedAt = Date.now()
  const exitedEarly = async (): Promise<DaemonLaunchdOutcome> => {
    // Why read again: the report can land between the loop's read and the exit seen after it.
    const report = readDaemonLaunchdReport(paths.reportPath)
    const { lastExitCode } = await printJob(launchctl, uid, paths.label)
    if (report?.type === 'endpoint-unavailable' || lastExitCode === DAEMON_EXIT_ENDPOINT_OCCUPIED) {
      // Lost the endpoint race before it could say so in its report.
      await jobs.bootout(paths.label).catch(warnLaunchdFailure('bootout'))
      removeQuietly(paths.reportPath)
      return { kind: 'endpoint-unavailable', reason: 'occupied' }
    }
    return fail(
      `Daemon exited during startup${lastExitCode === null ? '' : ` (launchd: last exit code ${lastExitCode})`}`
    )
  }
  for (;;) {
    const report = readDaemonLaunchdReport(paths.reportPath)
    if (report?.type === 'ready') {
      const identity = parseDaemonReadyIdentity(report)
      if (!identity) {
        return fail('Daemon readiness identity is incomplete')
      }
      removeQuietly(paths.reportPath)
      return {
        kind: 'ready',
        child: new LaunchdDaemonProcess(identity.pid, paths.label, jobs, {
          startedAtMs: identity.startedAtMs
        }),
        identity
      }
    }
    if (report?.type === 'endpoint-unavailable') {
      // The daemon exits on its own; its job stays loaded until booted out.
      await jobs.bootout(paths.label).catch(warnLaunchdFailure('bootout'))
      removeQuietly(paths.reportPath)
      return {
        kind: 'endpoint-unavailable',
        reason: typeof report.reason === 'string' ? report.reason : 'occupied'
      }
    }
    if (report?.type === 'started' && typeof report.pid === 'number') {
      pid = report.pid
    }
    if (pid === null && Date.now() - printedAt >= PRINT_POLL_MS) {
      const printed = await printJob(launchctl, uid, paths.label)
      printedAt = Date.now()
      pid = printed.pid
      if (pid === null && printed.lastExitCode !== null) {
        return exitedEarly()
      }
    }
    if (pid !== null && !processIsAlive(pid)) {
      return exitedEarly()
    }
    if (Date.now() >= deadline) {
      return fail('Daemon startup timed out')
    }
    await new Promise((resolve) => setTimeout(resolve, REPORT_POLL_MS))
  }
}
