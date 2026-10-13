import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import {
  getProcessOutputFields,
  iterateProcessOutputLines
} from '../../shared/process-output-field-scanner'
import { getPsProcessIdentity } from './daemon-process-identity-query'

export const START_TIME_TOLERANCE_MS = 1_500
/** How long a daemon's OS start may precede the start it reports (`Date.now() - uptime`): dyld,
 *  Electron and node init, 3.52 s on a cold boot; capped at the daemon's first-start budget. */
export const SELF_REPORTED_START_LEAD_MS = 30_000

function getLinuxProcessStartedAtMs(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const startTicks = parseLinuxProcStartTicks(stat)
    const bootTimeSeconds = parseLinuxBootTimeSeconds(readFileSync('/proc/stat', 'utf8'))
    const ticksPerSecond = Number(
      execFileSync('getconf', ['CLK_TCK'], {
        encoding: 'utf8',
        timeout: 1_000
      }).trim()
    )
    if (
      !Number.isFinite(startTicks) ||
      !Number.isFinite(bootTimeSeconds) ||
      !Number.isFinite(ticksPerSecond) ||
      ticksPerSecond <= 0
    ) {
      return null
    }
    return bootTimeSeconds * 1000 + (startTicks / ticksPerSecond) * 1000
  } catch {
    return null
  }
}

export function parseLinuxProcStartTicks(stat: string): number {
  const commandEndIndex = stat.lastIndexOf(')')
  if (commandEndIndex === -1) {
    return Number.NaN
  }

  const fields = getProcessOutputFields(stat.slice(commandEndIndex + 1), 20)
  return Number(fields[19])
}

export function parseLinuxBootTimeSeconds(procStat: string): number {
  for (const line of iterateProcessOutputLines(procStat)) {
    if (!line.startsWith('btime ')) {
      continue
    }
    return Number(getProcessOutputFields(line, 2)[1])
  }
  return Number.NaN
}

export function getProcessStartedAtMs(pid: number): number | null {
  if (process.platform === 'linux') {
    return getLinuxProcessStartedAtMs(pid)
  }

  if (process.platform === 'win32') {
    // Why: the only OS source is a CIM query costing a powershell spawn —
    // too slow for this sync path. Windows pid files instead carry the
    // daemon's self-reported start time from its ready message, and
    // isDaemonProcess verifies it against CIM CreationDate asynchronously.
    return null
  }

  return getPsProcessIdentity(pid)?.startedAtMs ?? null
}

/** `expectedStartedAtMs` is the daemon's self-reported start (pid file or hello). */
export function startTimeMatches(pid: number, expectedStartedAtMs: number | null): boolean {
  return selfReportedStartMatches(getProcessStartedAtMs(pid), expectedStartedAtMs)
}

// Why asymmetric: the OS start always precedes the self-reported one, while a reused pid's
// process starts after the original died, so later. Fails open on null, like the symmetric check.
export function selfReportedStartMatches(
  osStartedAtMs: number | null,
  reportedStartedAtMs: number | null
): boolean {
  if (osStartedAtMs === null || reportedStartedAtMs === null) {
    return true
  }
  return (
    osStartedAtMs >= reportedStartedAtMs - SELF_REPORTED_START_LEAD_MS &&
    osStartedAtMs <= reportedStartedAtMs + START_TIME_TOLERANCE_MS
  )
}

// Why: fail open on null — a pid file or OS query without a start time must
// not veto an otherwise-matching daemon (adoption safety beats recycle safety).
export function startTimesWithinTolerance(
  actualStartedAtMs: number | null,
  expectedStartedAtMs: number | null,
  toleranceMs: number
): boolean {
  if (expectedStartedAtMs === null || actualStartedAtMs === null) {
    return true
  }
  return Math.abs(actualStartedAtMs - expectedStartedAtMs) <= toleranceMs
}
