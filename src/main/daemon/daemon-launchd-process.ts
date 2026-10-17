// Fork-only (Pod): the handle of a daemon launchd started (daemon-launchd-launch.ts).
import { EventEmitter } from 'node:events'
import { getProcessStartedAtMs, selfReportedStartMatches } from './daemon-process-start-time'

const EXIT_POLL_MS = 250
const TERMINATE_GRACE_MS = 5_000
const TERMINATE_FORCE_WAIT_MS = 10_000

export function processIsAlive(pid: number): boolean {
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

/** How the handle reaches the job; only through launchd, which knows this job's own pid. */
export type DaemonLaunchdJobControl = {
  bootout(label: string): Promise<void>
  signal(label: string, signal: NodeJS.Signals): Promise<void>
}

export type LaunchdDaemonProcessOptions = {
  /** The daemon's self-reported start (ready identity), to tell it from a process reusing its pid. */
  startedAtMs?: number | null
  isAlive?: (pid: number) => boolean
  osStartedAtMs?: (pid: number) => number | null
  graceMs?: number
  forceWaitMs?: number
}

/**
 * What the launcher keeps of a daemon launchd started, in place of a ChildProcess. launchd is its
 * parent, so nothing reaps it for us: signals go through launchd by label (one label per launch,
 * so only this daemon), never to the pid, which another process may reuse once it is gone. Its
 * exit is seen by polling the pid while someone listens, and its job is booted out then.
 */
export class LaunchdDaemonProcess extends EventEmitter {
  readonly connected = false
  readonly signalCode: NodeJS.Signals | null = null
  private exited = false
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly startedAtMs: number | null
  private readonly isAlive: (pid: number) => boolean
  private readonly osStartedAtMs: (pid: number) => number | null
  private readonly graceMs: number
  private readonly forceWaitMs: number

  constructor(
    readonly pid: number,
    readonly label: string,
    private readonly control: DaemonLaunchdJobControl,
    options: LaunchdDaemonProcessOptions = {}
  ) {
    super()
    this.startedAtMs = options.startedAtMs ?? null
    this.isAlive = options.isAlive ?? processIsAlive
    this.osStartedAtMs = options.osStartedAtMs ?? getProcessStartedAtMs
    this.graceMs = options.graceMs ?? TERMINATE_GRACE_MS
    this.forceWaitMs = options.forceWaitMs ?? TERMINATE_FORCE_WAIT_MS
    this.on('newListener', (event) => {
      if (event === 'exit') {
        this.watch()
      }
    })
  }

  /** null while it runs; -1 once it is gone (launchd reaped it, so its code isn't ours to see). */
  get exitCode(): number | null {
    if (!this.exited && !this.isOurs()) {
      this.markExited()
    }
    return this.exited ? -1 : null
  }

  /** true once launchd is asked, before it delivers (async); false once the daemon is gone. */
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.exitCode !== null) {
      return false
    }
    void this.control.signal(this.label, signal).catch(warnLaunchdFailure('signal'))
    return true
  }

  /** SIGTERM through launchd, then bootout (launchd's own SIGKILL after ExitTimeOut). */
  async terminate(): Promise<void> {
    if (this.exitCode !== null) {
      return
    }
    await this.control.signal(this.label, 'SIGTERM').catch(warnLaunchdFailure('signal'))
    if (await this.exitWithin(this.graceMs)) {
      return
    }
    await this.control.bootout(this.label).catch(warnLaunchdFailure('bootout'))
    if (!(await this.exitWithin(this.forceWaitMs))) {
      throw new Error('Daemon did not exit after its launchd job was booted out')
    }
  }

  disconnect(): void {}

  unref(): void {
    this.timer?.unref()
  }

  // Why the start time too: a pid launchd reaped may already be another process's. An unreadable
  // start (null) leaves the pid check alone, the safe side for signals, which go through launchd.
  private isOurs(): boolean {
    return (
      this.isAlive(this.pid) &&
      selfReportedStartMatches(this.osStartedAtMs(this.pid), this.startedAtMs)
    )
  }

  private exitWithin(ms: number): Promise<boolean> {
    if (this.exitCode !== null) {
      return Promise.resolve(true)
    }
    return new Promise((resolve) => {
      const onExit = (): void => {
        clearTimeout(timer)
        resolve(true)
      }
      const timer = setTimeout(() => {
        this.off('exit', onExit)
        resolve(false)
      }, ms)
      this.once('exit', onExit)
    })
  }

  private watch(): void {
    if (this.timer || this.exited) {
      return
    }
    // Why the cheap check while polling: a pid can't die and be reused between two polls.
    this.timer = setInterval(() => {
      if (!this.isAlive(this.pid)) {
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
    void this.control.bootout(this.label).catch(warnLaunchdFailure('bootout'))
    // Why later: exitCode reads can mark it, and a ChildProcess sets its code before 'exit'.
    queueMicrotask(() => this.emit('exit', -1, null))
  }
}

export function warnLaunchdFailure(step: string): (error: unknown) => void {
  return (error) =>
    console.warn(
      `[daemon] launchd ${step} failed:`,
      error instanceof Error ? error.message : String(error)
    )
}
