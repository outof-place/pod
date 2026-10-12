// Fork-only (Pod): what a daemon that launchd started (daemon-launchd-launch.ts) tells its
// launcher. Such a daemon has no IPC channel, so the launcher reads these files instead of
// messages. The records have the same shape as the forked daemon's IPC messages.
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
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
