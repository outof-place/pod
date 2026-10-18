import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
// Same file name and failure fields as claude-acc's record, so its failedSetup backoff applies as is.
import { ACC_LIFECYCLE_RECORD } from '../acc/acc-lifecycle-record'
// types only: the lifecycle imports this module
import type { PodGoCacheLifecycleOutcome } from './pod-gocache-lifecycle'

export type PodGoCacheLifecycleRecord = {
  version: 1
  at: string
  pid: number
  app: string
  /** The bundled helper's version this launch acted on; null for a removal, which reads none. */
  payload: string | null
  status: 'installed' | 'removed' | 'failed' | 'refused' | 'up-to-date'
  reason: string | null
  /** The installed helper's version before this launch. */
  from: string | null
  exit: number | null
  timedOut: boolean
  message: string | null
  /** Installs of this version that failed in a row, this one included; 0 when it did not fail. */
  attempts: number
}

/**
 * Null for skips (a harness launch never writes the account's state), busy (the other Pod's) and
 * a dry run, which changes nothing.
 */
export function podGoCacheLifecycleRecord(
  outcome: PodGoCacheLifecycleOutcome,
  context: { app: string; at: Date; pid: number }
): PodGoCacheLifecycleRecord | null {
  const { decision } = outcome
  if (
    decision.action === 'skip' ||
    outcome.status === 'skipped' ||
    outcome.status === 'busy' ||
    outcome.status === 'dry-run'
  ) {
    return null
  }
  const failed = outcome.status === 'failed'
  const install = decision.action === 'install' ? decision : null
  return {
    version: 1,
    at: context.at.toISOString(),
    pid: context.pid,
    app: context.app,
    payload: decision.action === 'remove' ? null : decision.version,
    status: outcome.status,
    reason: decision.action === 'up-to-date' ? null : decision.reason,
    from: install?.from ?? null,
    exit: 'exit' in outcome ? outcome.exit : null,
    timedOut: 'timedOut' in outcome ? outcome.timedOut : false,
    message: 'message' in outcome ? outcome.message || null : null,
    attempts: failed ? (install?.failedAttempts ?? 0) + 1 : 0
  }
}

/** The last record's status, null without a readable one. */
export function lastPodGoCacheLifecycleStatus(stateDir: string): string | null {
  try {
    const record: unknown = JSON.parse(readFileSync(join(stateDir, ACC_LIFECYCLE_RECORD), 'utf8'))
    const status: unknown = Reflect.get(Object(record), 'status')
    return typeof status === 'string' ? status : null
  } catch {
    return null
  }
}

export function writePodGoCacheLifecycleRecord(
  stateDir: string,
  outcome: PodGoCacheLifecycleOutcome,
  context: { app: string; at: Date; pid: number }
): boolean {
  const record = podGoCacheLifecycleRecord(outcome, context)
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
