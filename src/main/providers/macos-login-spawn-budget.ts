// Fork-only (Pod): a spawn's wait on a login(1) probe (macos-tcc-login-shell.ts), apart from the
// probe's own bound: under load PAM answers slowly, the probe runs on and caches its verdict for
// later spawns, and a spawn goes direct once its budget is spent.
import type { LoginPreflightOutcome } from './macos-login-session-pty-probe'

/** Called once per probe, for the caller that started it (callers that joined it get none). */
export type LoginProbeSettled = (outcome: LoginPreflightOutcome, durationMs: number) => void

/** A probe's outcome, or a spawn's wait on it that ran out (`budgetExpired`: no probe said so). */
export type PreparedLoginShell = LoginPreflightOutcome & { budgetExpired?: true }

/** The probe's outcome, or after `budgetMs` one marked `budgetExpired`; the probe runs on. */
export function withinSpawnBudget(
  probe: Promise<LoginPreflightOutcome>,
  budgetMs: number
): Promise<PreparedLoginShell> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const budget = new Promise<PreparedLoginShell>((resolve) => {
    const expired: PreparedLoginShell = {
      ok: false,
      conclusive: false,
      reason: 'timeout',
      budgetExpired: true
    }
    timer = setTimeout(() => resolve(expired), budgetMs)
  })
  return Promise.race([probe, budget]).finally(() => clearTimeout(timer))
}
