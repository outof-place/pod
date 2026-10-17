// Fork-only (Pod): the daemon-host side of a launchd daemon (daemon-launchd-launch.ts): one job per
// launch, its plist (0600 under the daemon runtime dir: it holds the daemon's environment; removed
// once bootstrapped, so nothing persists, not even in ~/Library/LaunchAgents), and its bootout.
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { getLogsDirectory } from '../observability/logs-directory'
import type {
  DaemonLaunchdJob,
  DaemonLaunchdJobs,
  DaemonLaunchdPaths,
  RunLaunchctl
} from './daemon-launchd-launch'

const LAUNCHCTL_PATH = '/bin/launchctl'
const LAUNCHCTL_TIMEOUT_MS = 10_000
export const DAEMON_LAUNCHD_LABEL_PREFIX = 'codes.pod.daemon.'
export const DAEMON_LAUNCHD_STDERR_LOG_NAME = 'daemon-launchd-stderr.log'
/** The previous file is kept once as `.1`, like runtime-stderr.log. */
const STDERR_LOG_MAX_BYTES = 2 * 1024 * 1024
// launchctl's "no such service" exit codes: the job is already gone.
const BOOTOUT_GONE_CODES = new Set([3, 113])

const runLaunchctl: RunLaunchctl = (args) =>
  runProcess({ program: LAUNCHCTL_PATH, args, timeoutMs: LAUNCHCTL_TIMEOUT_MS })

/** Every job of this profile starts with it, so two profiles never sweep each other's. */
export function daemonLaunchdLabelPrefix(userDataPath: string): string {
  return `${DAEMON_LAUNCHD_LABEL_PREFIX}${createHash('sha256').update(userDataPath).digest('hex').slice(0, 12)}.`
}

/** Under userData/daemon, which an uninstall's zap already removes. */
export function daemonLaunchdJobsDir(runtimeDir: string): string {
  return join(runtimeDir, 'launchd')
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const string = (value: string): string => `<string>${escapeXml(value)}</string>`

export function daemonLaunchdPlist(paths: DaemonLaunchdPaths, job: DaemonLaunchdJob): string {
  const env = Object.entries(job.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([key, value]) => `    <key>${escapeXml(key)}</key>${string(value)}`)
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    `  <key>Label</key>${string(paths.label)}`,
    '  <key>ProgramArguments</key><array>',
    ...[job.program, ...job.args].map((arg) => `    ${string(arg)}`),
    '  </array>',
    '  <key>EnvironmentVariables</key><dict>',
    ...env,
    '  </dict>',
    `  <key>WorkingDirectory</key>${string(job.cwd)}`,
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><false/>',
    // Why Interactive: no launchd throttling of a process every keystroke passes through.
    '  <key>ProcessType</key><string>Interactive</string>',
    // Why: when the daemon exits, launchd would kill what is left in its process group; a forked
    // daemon never took anything down with it, so neither does this one.
    '  <key>AbandonProcessGroup</key><true/>',
    `  <key>ExitTimeOut</key><integer>${job.exitTimeoutSeconds}</integer>`,
    '  <key>SoftResourceLimits</key><dict>',
    `    <key>NumberOfFiles</key><integer>${job.numberOfFiles}</integer>`,
    '  </dict>',
    `  <key>StandardOutPath</key>${string(paths.stdoutPath)}`,
    `  <key>StandardErrorPath</key>${string(paths.stderrPath)}`,
    '</dict></plist>',
    ''
  ].join('\n')
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // Already gone.
  }
}

/** This launch's section of the stderr log: rotated past 2 MB, then a marker line. */
function startStderrSection(path: string, label: string): void {
  try {
    if (statSync(path).size > STDERR_LOG_MAX_BYTES) {
      renameSync(path, `${path}.1`)
    }
  } catch {
    // No log yet.
  }
  try {
    appendFileSync(path, `--- ${new Date().toISOString()} ${label}\n`, { mode: 0o600 })
  } catch {
    // Fail-open: launchd creates the file itself.
  }
}

export function createDarwinDaemonLaunchdJobs(
  jobsDir: string,
  launchctl: RunLaunchctl = runLaunchctl,
  logsDirectory: () => string = getLogsDirectory
): DaemonLaunchdJobs {
  const uid = process.getuid?.() ?? -1
  return {
    paths: ({ userDataPath, launchNonce }) => {
      const label = `${daemonLaunchdLabelPrefix(userDataPath)}${launchNonce}`
      return {
        label,
        plistPath: join(jobsDir, `${label}.plist`),
        reportPath: join(jobsDir, `${label}.report.json`),
        stdoutPath: '/dev/null',
        stderrPath: join(logsDirectory(), DAEMON_LAUNCHD_STDERR_LOG_NAME)
      }
    },
    writePlist: (paths, job) => {
      const dir = join(paths.plistPath, '..')
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      // Why chmod too: mkdir's mode applies only to a directory it creates.
      chmodSync(dir, 0o700)
      mkdirSync(join(paths.stderrPath, '..'), { recursive: true, mode: 0o700 })
      startStderrSection(paths.stderrPath, paths.label)
      const temporary = `${paths.plistPath}.${process.pid}.tmp`
      writeFileSync(temporary, daemonLaunchdPlist(paths, job), { mode: 0o600 })
      renameSync(temporary, paths.plistPath)
    },
    bootout: async (label) => {
      const result = await launchctl(['bootout', `gui/${uid}/${label}`])
      if (result.code !== 0 && !BOOTOUT_GONE_CODES.has(result.code ?? -1)) {
        throw new Error(`launchctl bootout exited ${result.code}: ${result.stderr.trim()}`)
      }
    }
  }
}

/** Jobs of this profile in `launchctl list` (PID, status, label per line), with their pids. */
export function parseDaemonLaunchdList(
  stdout: string,
  prefix: string
): { label: string; pid: number | null }[] {
  const jobs: { label: string; pid: number | null }[] = []
  for (const line of stdout.split('\n')) {
    const [pid, , label] = line.trim().split(/\s+/)
    if (label?.startsWith(prefix)) {
      jobs.push({ label, pid: /^\d+$/.test(pid ?? '') ? Number(pid) : null })
    }
  }
  return jobs
}

/** Boots out this profile's jobs with no pid (an adopted daemon's, gone since) and deletes files a
 *  crashed launch left. A job with a pid is a live daemon and never touched. Runs before a launch,
 *  in the same call, so it never races that launch's own bootstrap. */
export async function sweepDeadDaemonLaunchdJobs(
  userDataPath: string,
  jobsDir: string,
  jobs: Pick<DaemonLaunchdJobs, 'bootout'>,
  launchctl: RunLaunchctl = runLaunchctl
): Promise<string[]> {
  const prefix = daemonLaunchdLabelPrefix(userDataPath)
  const listed = await launchctl(['list']).catch(() => null)
  if (!listed || listed.code !== 0) {
    return []
  }
  const entries = parseDaemonLaunchdList(listed.stdout, prefix)
  const swept: string[] = []
  for (const { label, pid } of entries) {
    if (pid === null) {
      await jobs.bootout(label).then(
        () => swept.push(label),
        () => {}
      )
    }
  }
  const live = new Set(entries.filter((entry) => entry.pid !== null).map((entry) => entry.label))
  let names: string[] = []
  try {
    names = readdirSync(jobsDir)
  } catch {
    return swept
  }
  for (const name of names) {
    const label = name.replace(/\.(plist|report\.json)(\.\d+\.tmp)?$/, '')
    if (label.startsWith(prefix) && !live.has(label)) {
      removeQuietly(join(jobsDir, name))
    }
  }
  return swept
}
