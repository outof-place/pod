// Fork-only (Pod): what in the hook status store can move a worktree's worktree.ps ranking.
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../shared/agent-status-freshness'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status-types'
import type {
  RuntimeWorktreeAgentRow,
  RuntimeWorktreePsSummary
} from '../../../shared/runtime-types'

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

export type PodWorktreeRank = Pick<RuntimeWorktreePsSummary, 'status' | 'workingMode'> &
  Partial<Pick<RuntimeWorktreePsSummary, 'agents'>>

export function podRankKey(row: PodWorktreeRank): string {
  return `${row.status}\u0000${row.workingMode ?? ''}`
}

/** The hook store fields an agent row on a worktree card shows, for `worktreeStatus.agents`. */
export type PodAgentStatusRow = PodStatusRow &
  Partial<
    Pick<
      AgentStatusIpcPayload,
      | 'stateStartedAt'
      | 'agentType'
      | 'prompt'
      | 'toolName'
      | 'toolInput'
      | 'lastAssistantMessage'
      | 'interrupted'
      | 'mainAgent'
    >
  >

// A row's clock moves the key once a minute at most: enough for a reader's 30-minute decay.
const AGENT_ROW_CLOCK_MS = 60_000

/**
 * What the agent rows show, for subscribers that asked for them: the ranking fields plus the
 * prompt, the tool, the last message, the verdict and the row's clock by the minute. A tool update
 * moves it; only `worktreeStatus.agents` subscribers read for that.
 */
export function podAgentRowsSignature(rows: readonly PodAgentStatusRow[], now: number): string {
  return rows
    .map((row) =>
      JSON.stringify([
        row.paneKey,
        row.worktreeId ?? '',
        row.state,
        row.workingMode ?? '',
        row.stateStartedAt ?? 0,
        row.agentType ?? '',
        row.prompt ?? '',
        row.toolName ?? '',
        row.toolInput ?? '',
        row.lastAssistantMessage ?? '',
        row.interrupted === true,
        row.mainAgent ?? null,
        row.restoredUnconfirmed === true,
        rowCounts(row, now),
        Math.floor(observedAt(row) / AGENT_ROW_CLOCK_MS)
      ])
    )
    .sort()
    .join('\u0001')
}

/** A worktree's agent rows as worktree.ps sends them, keyed for the same comparison. */
export function podAgentRowsKey(agents: readonly RuntimeWorktreeAgentRow[] | undefined): string {
  return (agents ?? [])
    .map((agent) =>
      JSON.stringify([
        agent.paneKey,
        agent.parentPaneKey,
        agent.state,
        agent.workingMode ?? '',
        agent.agentType,
        agent.prompt,
        agent.taskTitle,
        agent.displayName,
        agent.lastAssistantMessage,
        agent.toolName,
        agent.toolInput,
        agent.interrupted,
        agent.mainAgent ?? null,
        agent.stateStartedAt,
        agent.restoredUnconfirmed === true,
        agent.structuredHostOwned === true,
        Math.floor(agent.updatedAt / AGENT_ROW_CLOCK_MS)
      ])
    )
    .sort()
    .join('\u0001')
}
