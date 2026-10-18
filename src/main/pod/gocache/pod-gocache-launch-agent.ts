import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'
import {
  isLaunchctlServiceGone,
  launchctlSpec,
  plistString as string
} from '../launchd/launchctl-darwin'
import {
  POD_GOCACHE_LABEL,
  podGoCacheDaemonLogPath,
  podGoCacheHelperPath,
  podGoCacheStateDir
} from './pod-gocache-paths'

// A crash loop restarts at most this often; launchd's default is 10 s.
const THROTTLE_INTERVAL_S = 30
// The daemon's SIGTERM budget to write owner.json (observe) and state.json before launchd's SIGKILL.
const EXIT_TIMEOUT_S = 10
// bootout waits for the job to exit, which may take all of ExitTimeOut.
const BOOTOUT_TIMEOUT_MS = (EXIT_TIMEOUT_S + 10) * 1000
/** How long launchd may still list the job after bootout returns: ExitTimeOut plus slack. */
export const TEARDOWN_WAIT_MS = (EXIT_TIMEOUT_S + 5) * 1000
// EINPROGRESS: launchd still tears the job down; the caller waits for `print` to report it gone.
const BOOTOUT_IN_PROGRESS = 36

export function podGoCacheDaemonArgs(home: string, cacheDir: string): string[] {
  return [podGoCacheHelperPath(home), 'daemon', '--cache-dir', cacheDir]
}

/** ~/Library/LaunchAgents/codes.pod.gocache.plist: loaded at every login, independent of Pod. */
export function podGoCacheLaunchAgentPlist(
  home: string,
  bundleId: string | null,
  cacheDir: string
): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    `  <key>Label</key>${string(POD_GOCACHE_LABEL)}`,
    '  <key>ProgramArguments</key><array>',
    ...podGoCacheDaemonArgs(home, cacheDir).map((arg) => `    ${string(arg)}`),
    '  </array>',
    // Login Items lists the agent under the app that installed it.
    ...(bundleId
      ? [`  <key>AssociatedBundleIdentifiers</key><array>${string(bundleId)}</array>`]
      : []),
    `  <key>WorkingDirectory</key>${string(podGoCacheStateDir(home))}`,
    '  <key>RunAtLoad</key><true/>',
    // A SIGKILL (memory brake, jetsam) or a crash restarts it; a clean exit 0 stays down.
    '  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>',
    `  <key>ThrottleInterval</key><integer>${THROTTLE_INTERVAL_S}</integer>`,
    // Why not Background: below 10 GB free it evicts at full speed and keeps its heartbeat fresh; otherwise it lowers its own I/O.
    '  <key>ProcessType</key><string>Standard</string>',
    `  <key>ExitTimeOut</key><integer>${EXIT_TIMEOUT_S}</integer>`,
    `  <key>StandardOutPath</key>${string('/dev/null')}`,
    `  <key>StandardErrorPath</key>${string(podGoCacheDaemonLogPath(home))}`,
    '</dict></plist>',
    ''
  ].join('\n')
}

function unescapePlistXml(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
}

/** ProgramArguments of a plist in the shape podGoCacheLaunchAgentPlist writes; null for any other. */
export function readPlistProgramArguments(plist: string): string[] | null {
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)?.[1]
  if (array === undefined) {
    return null
  }
  return [...array.matchAll(/<string>([^<]*)<\/string>/g)].map((match) =>
    unescapePlistXml(match[1] ?? '')
  )
}

export function bootoutSpec(uid: number): ProcessSpec {
  return launchctlSpec(['bootout', serviceTarget(uid)], BOOTOUT_TIMEOUT_MS)
}

export function serviceTarget(uid: number): string {
  return `gui/${uid}/${POD_GOCACHE_LABEL}`
}

export function isBootoutDone(result: ProcessResult): boolean {
  return (
    result.code === 0 || result.code === BOOTOUT_IN_PROGRESS || isLaunchctlServiceGone(result.code)
  )
}

/** What `launchctl print gui/<uid>/<label>` says of the agent; its output is not API, so only these. */
export function readAgentState(result: ProcessResult): 'running' | 'stopped' | 'not-loaded' | null {
  if (result.code === 113) {
    return 'not-loaded'
  }
  if (result.code !== 0) {
    return null
  }
  return /^\s*pid = \d+$/m.test(result.stdout) ? 'running' : 'stopped'
}

/** `launchctl print-disabled gui/<uid>` lists the label as `"<label>" => disabled` (older macOS: `true`). */
export function isAgentDisabled(result: ProcessResult): boolean {
  if (result.code !== 0) {
    return false
  }
  const label = POD_GOCACHE_LABEL.replace(/\./g, '\\.')
  return new RegExp(`^\\s*"${label}"\\s*=>\\s*(disabled|true)\\s*$`, 'm').test(result.stdout)
}
