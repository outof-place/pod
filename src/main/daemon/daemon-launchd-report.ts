// Fork-only (Pod): what a daemon that launchd started (daemon-launchd-launch.ts) tells its
// launcher. Such a daemon has no IPC channel, so the launcher reads these files instead of
// messages. The records have the same shape as the forked daemon's IPC messages.
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { spawnProcess } from '@orca/process-host'
import type { ProcessSpec } from '@orca/process-host/process-spec'
import type { DaemonReadyIdentity } from './daemon-ready-identity'

export const DAEMON_LAUNCHD_REPORT_ARG = '--launchd-report'

export type DaemonLaunchdReport =
  | { type: 'started'; pid: number }
  | ({ type: 'ready' } & DaemonReadyIdentity)
  | { type: 'endpoint-unavailable'; reason: string }

/** Whole or not at all (a rename), 0600, and it never throws: an unwritten report only costs the
 *  launcher its wait, which then times out and falls back to a fork. */
export function writeDaemonLaunchdReport(path: string, report: DaemonLaunchdReport): void {
  const temporary = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(report), { mode: 0o600 })
    renameSync(temporary, path)
  } catch {
    // Fail-open: see above.
  }
}

// The daemon's own report path (daemon-entry), once its arguments are read.
let ownReportPath: string | undefined

/** Reads `--launchd-report <path>` from the daemon's arguments; absent unless launchd started it. */
export function takeLaunchdReportPath(argv: string[]): void {
  const index = argv.indexOf(DAEMON_LAUNCHD_REPORT_ARG)
  ownReportPath = index !== -1 && argv[index + 1] ? argv[index + 1] : undefined
}

/** launchd puts its job's label (XPC_SERVICE_NAME) and XPC_FLAGS in the job's environment, which
 *  every PTY would inherit: dropped here, the label returned for the log. A no-op unless launchd
 *  started this daemon. */
export function dropLaunchdJobEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!ownReportPath) {
    return undefined
  }
  const label = env.XPC_SERVICE_NAME
  delete env.XPC_SERVICE_NAME
  delete env.XPC_FLAGS
  return label
}

/** Unloads this daemon's job once it exits, so no job outlives its daemon (an uninstall leaves no
 *  loaded job behind). The detached launchctl outlives the daemon: the job abandons its group. */
export function bootoutOwnLaunchdJobAtExit(
  label: string | undefined,
  spawn: (spec: ProcessSpec) => {
    unref(): void
    on(event: 'error', listener: () => void): unknown
  } = spawnProcess,
  target: { once(event: 'exit', listener: () => void): unknown } = process
): void {
  const uid = process.getuid?.()
  // Why the prefix: only a job Pod made; a launchd-started runtime carries its own label.
  if (!label?.startsWith('codes.pod.daemon.') || uid === undefined) {
    return
  }
  target.once('exit', () => {
    try {
      const child = spawn({
        program: '/bin/launchctl',
        args: ['bootout', `gui/${uid}/${label}`],
        detached: true,
        stdio: 'ignore'
      })
      child.on('error', () => {})
      child.unref()
    } catch {
      // The next launch's sweep boots it out.
    }
  })
}

/** daemon-entry's launchd start: the report path, the first report, the job env dropped and the
 *  job's bootout at exit. Returns the label; all no-ops unless launchd started this daemon. */
export function startAsLaunchdJob(argv: string[]): string | undefined {
  takeLaunchdReportPath(argv)
  reportToLaunchd({ type: 'started', pid: process.pid })
  const label = dropLaunchdJobEnv()
  bootoutOwnLaunchdJobAtExit(label)
  return label
}

/** A no-op unless launchd started this daemon. */
export function reportToLaunchd(report: DaemonLaunchdReport): void {
  if (ownReportPath) {
    writeDaemonLaunchdReport(ownReportPath, report)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** The newest record, or null while there is none (or it isn't JSON). */
export function readDaemonLaunchdReport(path: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}
