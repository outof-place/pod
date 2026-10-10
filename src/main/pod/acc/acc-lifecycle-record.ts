import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ACC_STATE_DIR, type AccLifecycleOutcome, type AccOwnerRecord } from './acc-lifecycle'

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
    message: 'message' in outcome ? outcome.message || null : null
  }
}

/** Writes the record when there is one; returns whether it did. */
export function writeAccLifecycleRecord(
  home: string,
  outcome: AccLifecycleOutcome,
  context: { app: string; at: Date; pid: number }
): boolean {
  const record = accLifecycleRecord(outcome, context)
  if (!record) {
    return false
  }
  const dir = join(home, ACC_STATE_DIR)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, ACC_LIFECYCLE_RECORD)
  // a reader must never see half of it
  writeFileSync(`${path}.tmp`, `${JSON.stringify(record, null, 2)}\n`)
  renameSync(`${path}.tmp`, path)
  return true
}
