// Fork-only (Pod): what in the hook status store can move a worktree's worktree.ps ranking.
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../shared/agent-status-freshness'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status-types'
import type { RuntimeWorktreePsSummary } from '../../../shared/runtime-types'

export type PodStatusRow = Pick<
  AgentStatusIpcPayload,
  | 'paneKey'
  | 'worktreeId'
  | 'terminalHandle'
  | 'tabId'
  | 'state'
  | 'workingMode'
  | 'receivedAt'
  | 'evidenceObservedAt'
  | 'restoredUnconfirmed'
  | 'providerSessionOnly'
  | 'structuredHost'
>

/** worktree.ps's rule (pty agent sources, then agent rows): admitted, not done, not stale. */
function rowCounts(row: PodStatusRow, now: number): boolean {
  if (
    row.restoredUnconfirmed === true ||
    row.providerSessionOnly === true ||
    row.state === 'done'
  ) {
    return false
  }
  return row.structuredHost === 'owned' || now - observedAt(row) <= AGENT_STATUS_STALE_AFTER_MS
}

function observedAt(row: PodStatusRow): number {
  return row.evidenceObservedAt ?? row.receivedAt
}

/**
 * The fields worktree.ps ranks a row by. A tool or prompt update leaves it unchanged, so a working
 * agent's hook stream costs no catalog reads.
 */
export function podStatusSignature(rows: readonly PodStatusRow[], now: number): string {
  return rows
    .map((row) =>
      [
        row.paneKey,
        row.worktreeId ?? '',
        row.terminalHandle ?? '',
        row.tabId ?? '',
        row.state,
        row.workingMode ?? '',
        rowCounts(row, now) ? 'f' : 's'
      ].join('\u0000')
    )
    .sort()
    .join('\u0001')
}

/** When the next counted row goes stale (no hook fires for that), or null when none can. */
export function podNextDecayAt(rows: readonly PodStatusRow[], now: number): number | null {
  let next: number | null = null
  for (const row of rows) {
    if (row.structuredHost === 'owned' || !rowCounts(row, now)) {
      continue
    }
    const at = observedAt(row) + AGENT_STATUS_STALE_AFTER_MS + 1
    next = next === null ? at : Math.min(next, at)
  }
  return next
}

export type PodWorktreeRank = Pick<RuntimeWorktreePsSummary, 'status' | 'workingMode'>

export function podRankKey(row: PodWorktreeRank): string {
  return `${row.status}\u0000${row.workingMode ?? ''}`
}
