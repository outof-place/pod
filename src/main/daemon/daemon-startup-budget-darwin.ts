// Fork-only (Pod): a daemon forked from a fresh daemon-host clone pays macOS's first-exec
// assessment for every file it maps (new inodes): over 10 s at load ~46, so upstream's 10 s
// readiness timeout sent a fresh profile's first start to local PTYs.

/** The fork's share in DAEMON_RECOVERY_BUDGET_MS's accounting (upstream's readiness timeout). */
const UPSTREAM_FORK_READY_MS = 10_000
/** killStaleDaemon's hard cap in the same accounting. */
const STALE_DAEMON_KILL_MS = 10_500
export const DARWIN_COLD_EXEC_READY_MS = 30_000

/** The fork gets what recovery and the stale kill left unspent, between 10 s and 30 s. */
export function darwinDaemonStartupTimeoutMs(
  recoveryDeadlineMs: number,
  now: number = Date.now(),
  platform: NodeJS.Platform = process.platform
): number | undefined {
  if (platform !== 'darwin') {
    return undefined
  }
  const unspent = recoveryDeadlineMs + STALE_DAEMON_KILL_MS + UPSTREAM_FORK_READY_MS - now
  return Math.min(DARWIN_COLD_EXEC_READY_MS, Math.max(UPSTREAM_FORK_READY_MS, unspent))
}
