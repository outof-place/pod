// Fork-only (Pod): the macOS daemon as a launchd job in the user's GUI domain (POD_DAEMON_LAUNCHD=1).
// A forked daemon stays in the runtime's coalition, where CLPC keeps the terminals' short
// interactive bursts on E-cores; a job gets a coalition of its own and ProcessType Interactive.
import { EventEmitter } from 'node:events'
import { readFileSync, unlinkSync } from 'node:fs'
import { runProcess } from '@orca/process-host'
import type { ProcessResult } from '@orca/process-host/process-spec'
import { daemonNodeExecutable } from './daemon-app-scheduling-policy'
import {
  buildDaemonChildEnv,
  buildDaemonScriptArgs,
  type DaemonChildSpawnOptions
} from './daemon-launched-child-spawn'
import { DAEMON_LAUNCHD_REPORT_ARG, readDaemonLaunchdReport } from './daemon-launchd-report'
import { parseDaemonReadyIdentity, type DaemonReadyIdentity } from './daemon-ready-identity'

const LAUNCHCTL_PATH = '/bin/launchctl'
const LAUNCHCTL_TIMEOUT_MS = 10_000
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000
const REPORT_POLL_MS = 25
const EXIT_POLL_MS = 250
const STDERR_TAIL_BYTES = 8192

export function isLaunchdDaemonLaunchEnabled(): boolean {
  return process.platform === 'darwin' && process.env.POD_DAEMON_LAUNCHD === '1'
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
  const program = daemonNodeExecutable(options.relocatedExecPath)
  const uid = process.getuid?.()
  if (!program || uid === undefined) {
    throw new Error('no executable or user for a launchd daemon')
  }
  const paths = jobs.paths({ userDataPath: options.userDataPath, launchNonce: options.launchNonce })
  removeQuietly(paths.reportPath)
  jobs.writePlist(paths, {
    program,
    args: [
      options.forkEntryPath,
      ...buildDaemonScriptArgs(options),
      DAEMON_LAUNCHD_REPORT_ARG,
      paths.reportPath
    ],
    env: buildDaemonChildEnv(options),
    cwd: options.userDataPath
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
  let pid: number | null = null
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
    if (pid !== null && !processIsAlive(pid)) {
      return fail('Daemon exited during startup')
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
