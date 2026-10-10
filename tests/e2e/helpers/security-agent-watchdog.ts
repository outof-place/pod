/**
 * Fork-only (Pod): stops a packaged-app run the moment macOS starts SecurityAgent, the process that
 * draws keychain and authorization prompts. A prompt in an automated run lands on the user's
 * desktop, and "Keychain Not Found" offers a reset of their login keychain.
 */
import { spawnSync } from 'node:child_process'

export type SecurityAgentWatchdog = {
  /** True once a SecurityAgent the run did not start with appeared. */
  tripped: () => boolean
  stop: () => void
}

export function runningSecurityAgentPids(): number[] {
  const result = spawnSync('pgrep', ['-x', 'SecurityAgent'], { encoding: 'utf8' })
  // pgrep exits 1 when nothing matches.
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`pgrep failed: ${result.stderr || result.error?.message || result.status}`)
  }
  return result.stdout
    .split('\n')
    .map((line) => Number.parseInt(line, 10))
    .filter((pid) => Number.isInteger(pid))
}

function killAppTree(appBundlePath: string): void {
  // Every process of a packaged app (helpers, daemon, sidecars) runs a binary inside its bundle.
  spawnSync('pkill', ['-KILL', '-f', `${appBundlePath}/Contents/`])
}

/** Polls for a new SecurityAgent; on one, SIGKILLs every process running from `appBundlePath`. */
export function startSecurityAgentWatchdog(
  appBundlePath: string,
  baseline: readonly number[],
  intervalMs = 200
): SecurityAgentWatchdog {
  const known = new Set(baseline)
  let tripped = false
  const timer = setInterval(() => {
    if (runningSecurityAgentPids().some((pid) => !known.has(pid))) {
      tripped = true
      killAppTree(appBundlePath)
      clearInterval(timer)
    }
  }, intervalMs)
  return {
    tripped: () => tripped,
    stop: () => clearInterval(timer)
  }
}
