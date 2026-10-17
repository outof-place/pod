// Fork-only (Pod): the macOS daemon as a launchd job in the user's GUI domain (kill switch
// POD_DAEMON_LAUNCHD=0). A job leads its own coalition for its whole life, and launchservicesd
// gives an app exec'd into a coalition with a live leader no coalition of its own. A forked daemon
// sits in the runtime's coalition, which loses its leader when the runtime quits; an app started
// from a terminal could then own it, and its quit or Force Quit ends every session (M10).
import { EventEmitter } from 'node:events'
import { readFileSync, unlinkSync } from 'node:fs'
import { runProcess } from '@orca/process-host'
import type { ProcessResult } from '@orca/process-host/process-spec'
import { daemonAppPolicyLaunch, daemonNodeExecutable } from './daemon-app-scheduling-policy'
import {
  buildDaemonChildEnv,
  buildDaemonScriptArgs,
  type DaemonChildSpawnOptions
} from './daemon-launched-child-spawn'
import { DAEMON_LAUNCHD_REPORT_ARG, readDaemonLaunchdReport } from './daemon-launchd-report'
import { parseDaemonReadyIdentity, type DaemonReadyIdentity } from './daemon-ready-identity'
import { DAEMON_EXIT_ENDPOINT_OCCUPIED } from './daemon-endpoint-ownership'

const LAUNCHCTL_PATH = '/bin/launchctl'
const LAUNCHCTL_TIMEOUT_MS = 10_000
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000
const REPORT_POLL_MS = 25
const EXIT_POLL_MS = 250
const PRINT_POLL_MS = 500
const STDERR_TAIL_BYTES = 8192
// The daemon's SIGTERM budget (daemon-entry SHUTDOWN_TIMEOUT_MS, 5 s) plus its reply flush (1 s)
// and a second of slack, before launchd's SIGKILL.
const DAEMON_EXIT_TIMEOUT_S = 7
// launchd's default soft NOFILE for a job is 256; a daemon holds several descriptors per PTY.
const DAEMON_NUMBER_OF_FILES = 10_240

export function isLaunchdDaemonLaunchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (process.platform !== 'darwin') {
    return false
  }
  // Why opt-in under vitest: a unit test on a Mac would bootstrap real jobs in the user's GUI domain.
  return env.VITEST ? env.POD_DAEMON_LAUNCHD === '1' : env.POD_DAEMON_LAUNCHD !== '0'
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
export type DaemonLaunchdJobs = {
  paths(options: { userDataPath: string; launchNonce: string }): DaemonLaunchdPaths
  writePlist(paths: DaemonLaunchdPaths, job: DaemonLaunchdJob): void
  bootout(label: string): Promise<void>
}

export type RunLaunchctl = (args: string[]) => Promise<ProcessResult>

export type DaemonLaunchdOutcome =
  | { kind: 'ready'; child: LaunchdDaemonProcess; identity: DaemonReadyIdentity }
  | { kind: 'endpoint-unavailable'; reason: string }

const runLaunchctl: RunLaunchctl = (args) =>
  runProcess({ program: LAUNCHCTL_PATH, args, timeoutMs: LAUNCHCTL_TIMEOUT_MS })

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ESRCH'
    )
  }
}

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
  const executable = daemonNodeExecutable(options.relocatedExecPath)
  const uid = process.getuid?.()
  if (!executable || uid === undefined) {
    throw new Error('no executable or user for a launchd daemon')
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
    env: buildDaemonChildEnv(options),
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
    await jobs.bootout(paths.label).catch(() => {})
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
    const { lastExitCode } = await printJob(launchctl, uid, paths.label)
    if (lastExitCode === DAEMON_EXIT_ENDPOINT_OCCUPIED) {
      // Lost the endpoint race before it could say so in its report.
      await jobs.bootout(paths.label).catch(() => {})
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
        child: new LaunchdDaemonProcess(identity.pid, paths.label, (label) => jobs.bootout(label)),
        identity
      }
    }
    if (report?.type === 'endpoint-unavailable') {
      // The daemon exits on its own; its job stays loaded until booted out.
      await jobs.bootout(paths.label).catch(() => {})
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

/**
 * What the launcher keeps of a daemon launchd started, in place of a ChildProcess: launchd is its
 * parent, so its exit is seen by polling the pid (only while someone listens for it), and its job
 * is booted out once it is gone.
 */
export class LaunchdDaemonProcess extends EventEmitter {
  readonly connected = false
  readonly signalCode: NodeJS.Signals | null = null
  private exited = false
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    readonly pid: number,
    readonly label: string,
    private readonly bootout: (label: string) => Promise<void>
  ) {
    super()
    this.on('newListener', (event) => {
      if (event === 'exit') {
        this.watch()
      }
    })
  }

  /** null while it runs; -1 once it is gone (launchd reaped it, so its code isn't ours to see). */
  get exitCode(): number | null {
    if (!this.exited && !processIsAlive(this.pid)) {
      this.markExited()
    }
    return this.exited ? -1 : null
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    try {
      process.kill(this.pid, signal)
      return true
    } catch {
      return false
    }
  }

  disconnect(): void {}

  unref(): void {
    this.timer?.unref()
  }

  private watch(): void {
    if (this.timer || this.exited) {
      return
    }
    this.timer = setInterval(() => {
      if (!processIsAlive(this.pid)) {
        this.markExited()
      } else if (this.listenerCount('exit') === 0) {
        this.stopWatching()
      }
    }, EXIT_POLL_MS)
    this.timer.unref()
  }

  private stopWatching(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private markExited(): void {
    if (this.exited) {
      return
    }
    this.exited = true
    this.stopWatching()
    void this.bootout(this.label).catch(() => {})
    // Why later: exitCode reads can mark it, and a ChildProcess sets its code before 'exit'.
    queueMicrotask(() => this.emit('exit', -1, null))
  }
}
