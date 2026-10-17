// launchctl and launchd job files as Pod's per-user jobs use them: the terminal daemon's
// (src/main/daemon/daemon-launchd-*) and pod-gocache's agent (src/main/pod/gocache).
import { renameSync, statSync } from 'node:fs'
import { runProcess } from '@orca/process-host'
import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'

export const LAUNCHCTL_PATH = '/bin/launchctl'
export const LAUNCHCTL_TIMEOUT_MS = 10_000
// launchctl's "no such service" exit codes: the job is already gone.
const SERVICE_GONE_CODES = new Set([3, 113])
/** The previous file is kept once as `.1`, like runtime-stderr.log. */
const JOB_LOG_MAX_BYTES = 2 * 1024 * 1024

export function launchctlSpec(args: string[], timeoutMs = LAUNCHCTL_TIMEOUT_MS): ProcessSpec {
  return { program: LAUNCHCTL_PATH, args, timeoutMs }
}

export function runLaunchctl(args: string[]): Promise<ProcessResult> {
  return runProcess(launchctlSpec(args))
}

export function isLaunchctlServiceGone(code: number | null): boolean {
  return SERVICE_GONE_CODES.has(code ?? -1)
}

/** Moves a job's log aside as `.1` once it passes 2 MB; no log yet is fine. */
export function rotateLaunchdJobLog(path: string): void {
  try {
    if (statSync(path).size > JOB_LOG_MAX_BYTES) {
      renameSync(path, `${path}.1`)
    }
  } catch {
    // No log yet.
  }
}

function escapePlistXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export const plistString = (value: string): string => `<string>${escapePlistXml(value)}</string>`

export const plistKey = (name: string): string => `<key>${escapePlistXml(name)}</key>`
