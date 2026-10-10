import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
// types only: acc-lifecycle imports failedSetup from here
import type { AccLifecycleOutcome, AccOwnerRecord } from './acc-lifecycle'

/**
 * $STATE/pod-lifecycle.json: what the last Pod launch decided about claude-acc. A Finder or `open`
 * launch discards the log line, and an up-to-date launch leaves owner.json alone by design.
 */
export const ACC_LIFECYCLE_RECORD = 'pod-lifecycle.json'

export type AccLifecycleRecord = {
  version: 1
  at: string
  pid: number
  app: string
  /** The payload's VERSION. */
  payload: string
  status: 'installed' | 'failed' | 'refused' | 'up-to-date' | 'dry-run'
  reason: string | null
  /** owner.json before this launch. */
  from: AccOwnerRecord | null
  exit: number | null
  timedOut: boolean
  message: string | null
  /** Setups of this payload that failed in a row, this one included; 0 when it did not fail. */
  attempts: number
}

// A failed setup reruns at the next launch, then 10 min, 20 min, … up to 6 h after the last try,
// so one that keeps failing never runs at every launch.
const RETRY_BASE_MS = 10 * 60_000
const RETRY_MAX_MS = 6 * 60 * 60_000

/** The last launch's failed setup of `version` (exit or timeout), and when it may run again. */
export function failedSetup(
  stateDir: string,
  version: string
): { attempts: number; notBefore: number } | null {
  let record: unknown
  try {
    record = JSON.parse(readFileSync(join(stateDir, ACC_LIFECYCLE_RECORD), 'utf8'))
  } catch {
    return null
  }
  if (
    typeof record !== 'object' ||
    record === null ||
    Reflect.get(record, 'status') !== 'failed' ||
    Reflect.get(record, 'payload') !== version
  ) {
    return null
  }
  const counted = Reflect.get(record, 'attempts')
  const attempts = typeof counted === 'number' && counted >= 1 ? Math.floor(counted) : 1
  const at = Date.parse(String(Reflect.get(record, 'at')))
  const wait = attempts < 2 ? 0 : Math.min(RETRY_BASE_MS * 2 ** (attempts - 2), RETRY_MAX_MS)
  return { attempts, notBefore: (Number.isNaN(at) ? 0 : at) + wait }
}

/**
 * Null for skips (a harness launch or foreign HOME never writes the account's $STATE, a build
 * without a payload never overwrites the installed app's record) and for busy (the other Pod's).
 */
export function accLifecycleRecord(
  outcome: AccLifecycleOutcome,
  context: { app: string; at: Date; pid: number }
): AccLifecycleRecord | null {
  const { decision } = outcome
  if (decision.action === 'skip' || outcome.status === 'skipped' || outcome.status === 'busy') {
    return null
  }
  const result = 'result' in outcome ? outcome.result : null
  return {
    version: 1,
    at: context.at.toISOString(),
    pid: context.pid,
    app: context.app,
    payload: decision.version,
    status: outcome.status,
    reason: decision.action === 'install' ? decision.reason : null,
    from: decision.action === 'install' ? decision.from : null,
    exit: result?.code ?? null,
    timedOut: result?.timedOut ?? false,
    message: 'message' in outcome ? outcome.message || null : null,
    attempts:
      outcome.status === 'failed'
        ? (decision.action === 'install' ? (decision.failedAttempts ?? 0) : 0) + 1
        : 0
  }
}

/** Writes the record when there is one; returns whether it did. */
export function writeAccLifecycleRecord(
  stateDir: string,
  outcome: AccLifecycleOutcome,
  context: { app: string; at: Date; pid: number }
): boolean {
  const record = accLifecycleRecord(outcome, context)
  if (!record) {
    return false
  }
  mkdirSync(stateDir, { recursive: true })
  const path = join(stateDir, ACC_LIFECYCLE_RECORD)
  // a reader must never see half of it
  writeFileSync(`${path}.tmp`, `${JSON.stringify(record, null, 2)}\n`)
  renameSync(`${path}.tmp`, path)
  return true
}
