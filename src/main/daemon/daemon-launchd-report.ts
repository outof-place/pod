// Fork-only (Pod): what a daemon that launchd started (daemon-launchd-launch.ts) tells its
// launcher. Such a daemon has no IPC channel, so the launcher reads these files instead of
// messages. The records have the same shape as the forked daemon's IPC messages.
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
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

/** What Electron's node mode drops from its environment at start when its parent process isn't
 *  signed as the same app (node_main.cc), and a job's parent, launchd, never is. A forked daemon
 *  keeps them, and every PTY inherits the daemon's environment. */
const PARENT_CHECKED_ENV = ['NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'NODE_REPL_EXTERNAL_MODULE']
const KEPT_ENV_PREFIX = 'POD_LAUNCHD_KEPT_'

/** The launcher's side: a copy of each, under a name Electron leaves alone, for the job's env. */
export function keepParentCheckedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = { ...env }
  for (const name of PARENT_CHECKED_ENV) {
    if (env[name] !== undefined) {
      kept[`${KEPT_ENV_PREFIX}${name}`] = env[name]
    }
  }
  return kept
}

/** launchd puts its job's label (XPC_SERVICE_NAME) and XPC_FLAGS in the job's environment, which
 *  every PTY would inherit: dropped here, the label returned for the log. The variables Electron
 *  dropped come back from their copies, so the PTYs get what a forked daemon's get. A no-op unless
 *  launchd started this daemon. */
export function dropLaunchdJobEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!ownReportPath) {
    return undefined
  }
  const label = env.XPC_SERVICE_NAME
  delete env.XPC_SERVICE_NAME
  delete env.XPC_FLAGS
  for (const name of PARENT_CHECKED_ENV) {
    const kept = env[`${KEPT_ENV_PREFIX}${name}`]
    delete env[`${KEPT_ENV_PREFIX}${name}`]
    if (kept !== undefined) {
      env[name] = kept
    }
  }
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
  // Why both: only the job Pod made for this daemon, whose label names its report file; a
  // launchd-started runtime carries a label of its own.
  if (!label?.startsWith('codes.pod.daemon.') || label !== ownLaunchdLabel() || uid === undefined) {
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

/** daemon-entry's launchd start: the report path, the first report and the job env dropped.
 *  Returns the label; all no-ops unless launchd started this daemon. */
export function startAsLaunchdJob(argv: string[]): string | undefined {
  takeLaunchdReportPath(argv)
  reportToLaunchd({ type: 'started', pid: process.pid })
  return dropLaunchdJobEnv()
}

/** The ready report, and from then on the job's bootout at exit. Why not earlier: before ready
 *  the launcher reads the job's exit code, which a bootout would erase. */
export function reportLaunchdReady(identity: DaemonReadyIdentity, label: string | undefined): void {
  reportToLaunchd({ type: 'ready', ...identity })
  if (ownReportPath) {
    bootoutOwnLaunchdJobAtExit(label)
  }
}

/** The label the launcher gave this launch: its report file is `<label>.report.json`. */
function ownLaunchdLabel(): string | undefined {
  return ownReportPath ? basename(ownReportPath).replace(/\.report\.json$/, '') : undefined
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
