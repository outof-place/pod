// Fork-only (Pod): the daemon's login(1) preflight and what it logs. Detached daemons destroy
// stderr, so each probe is logged once, by the call that started it, with its own verdict and
// duration (an accepted one too), and a spawn that stopped waiting on a slow probe is logged apart
// from any probe's verdict.
import { prepareMacosTccLoginShell } from '../providers/macos-tcc-login-shell'

export type DaemonLoginPreflightLog = (event: string, details: Record<string, unknown>) => void

/** At startup (`warmUp`: the probe's own bound) and before each spawn (a wait bounded by the spawn's
 *  budget). */
export function createDaemonLoginPreflight(
  log: DaemonLoginPreflightLog,
  prepare: typeof prepareMacosTccLoginShell = prepareMacosTccLoginShell
): (warmUp?: boolean) => Promise<void> {
  return async (warmUp = false) => {
    const startedAtMs = Date.now()
    const outcome = await prepare({
      warmUp,
      onProbeSettled: ({ ok, conclusive, reason }, durationMs) =>
        log('macos-login-preflight', { ok, conclusive, reason, durationMs, warmUp })
    })
    if (outcome?.budgetExpired) {
      log('macos-login-preflight-wait', { budgetExpired: true, waitedMs: Date.now() - startedAtMs })
    }
  }
}
