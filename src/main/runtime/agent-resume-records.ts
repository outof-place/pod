// The renderer's terminal-agent resume rules (cold-restore-resume-startup.ts, live anchors in
// agent-status-live-facts.ts), restated for a host with no renderer over the same records.
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import { agentResumeOriginNamesAnotherExecutionHost } from '../../shared/agent-resume-origin-host'
import {
  agentProviderSessionsEqual,
  getAgentResumeArgv,
  isResumableTuiAgent,
  normalizeAgentProviderSession,
  type AgentProviderSessionMetadata,
  type ResumableTuiAgent,
  type SleepingAgentLaunchConfig,
  type SleepingAgentSessionRecord
} from '../../shared/agent-session-resume'
import { LOCAL_EXECUTION_HOST_ID, toSshExecutionHostId } from '../../shared/execution-host'
import { parsePaneKey } from '../../shared/stable-pane-id'

export type PaneAgentResume = {
  agent: ResumableTuiAgent
  providerSession: AgentProviderSessionMetadata
  launchConfig?: SleepingAgentLaunchConfig
  /** The record this resume consumes; null when a status row named the session. */
  record: SleepingAgentSessionRecord | null
}

type ResumableIdentity = {
  agent: ResumableTuiAgent
  providerSession: AgentProviderSessionMetadata
}

function resumableIdentity(agent: unknown, rawProviderSession: unknown): ResumableIdentity | null {
  if (!isResumableTuiAgent(agent)) {
    return null
  }
  const providerSession = normalizeAgentProviderSession(rawProviderSession)
  if (!providerSession || !getAgentResumeArgv(agent, providerSession)) {
    return null
  }
  return { agent, providerSession }
}

// Why: a `providerSessionOnly` remnant is what a pane keeps after its agent exited under a live shell.
function liveResumableRow(
  rows: readonly AgentStatusIpcPayload[]
): (ResumableIdentity & { row: AgentStatusIpcPayload }) | null {
  for (const row of rows) {
    if (row.providerSessionOnly || row.structuredHost) {
      continue
    }
    const identity = resumableIdentity(row.agentType, row.providerSession)
    if (identity) {
      return { ...identity, row }
    }
  }
  return null
}

function sessionEndedUnderShell(
  rows: readonly AgentStatusIpcPayload[],
  identity: ResumableIdentity
): boolean {
  return rows.some(
    (row) =>
      row.providerSessionOnly === true &&
      row.agentType === identity.agent &&
      agentProviderSessionsEqual(
        identity.agent,
        normalizeAgentProviderSession(row.providerSession) ?? undefined,
        identity.providerSession
      )
  )
}

export function resumeOriginNamesAnotherHost(
  origin: string | null | undefined,
  connectionId: string | null
): boolean {
  return agentResumeOriginNamesAnotherExecutionHost(
    origin,
    connectionId === null ? LOCAL_EXECUTION_HOST_ID : toSshExecutionHostId(connectionId)
  )
}

/** What a pane started again resumes, in the renderer's cold-restore order: a row still mid-turn,
 *  then the pane's record, then a finished row (the identity the renderer's `live` anchor holds). */
export function resolvePaneAgentResume(args: {
  record: SleepingAgentSessionRecord | undefined
  rows: readonly AgentStatusIpcPayload[]
  connectionId: string | null
}): PaneAgentResume | null {
  const live = liveResumableRow(args.rows)
  const recordIdentity = args.record
    ? resumableIdentity(args.record.agent, args.record.providerSession)
    : null
  const fromRow = (
    identity: ResumableIdentity & { row: AgentStatusIpcPayload }
  ): PaneAgentResume | null => {
    if (resumeOriginNamesAnotherHost(identity.row.connectionId, args.connectionId)) {
      return null
    }
    const sameAsRecord =
      recordIdentity?.agent === identity.agent &&
      agentProviderSessionsEqual(
        identity.agent,
        recordIdentity.providerSession,
        identity.providerSession
      )
    return {
      agent: identity.agent,
      providerSession: identity.providerSession,
      ...(sameAsRecord && args.record?.launchConfig
        ? { launchConfig: args.record.launchConfig }
        : {}),
      record: null
    }
  }
  if (live && live.row.state !== 'done') {
    return fromRow(live)
  }
  if (
    args.record &&
    recordIdentity &&
    !sessionEndedUnderShell(args.rows, recordIdentity) &&
    !resumeOriginNamesAnotherHost(args.record.connectionId, args.connectionId)
  ) {
    return {
      ...recordIdentity,
      ...(args.record.launchConfig ? { launchConfig: args.record.launchConfig } : {}),
      record: args.record
    }
  }
  return live ? fromRow(live) : null
}

/** The agent a pane last ran when no resume identity is left for it: the session is not
 *  resumable here (another host, unusable id), as opposed to an agent that exited on its own. */
export function paneAgentWithoutResume(args: {
  record: SleepingAgentSessionRecord | undefined
  rows: readonly AgentStatusIpcPayload[]
}): string | null {
  const recordIdentity = args.record
    ? resumableIdentity(args.record.agent, args.record.providerSession)
    : null
  if (args.record && !(recordIdentity && sessionEndedUnderShell(args.rows, recordIdentity))) {
    return args.record.agent
  }
  const ranAgent = args.rows.find(
    (row) =>
      !row.providerSessionOnly &&
      !row.structuredHost &&
      row.agentType !== undefined &&
      row.agentType !== 'unknown'
  )
  return ranAgent?.agentType ?? null
}

/** The `live` anchor a status row stands for, or null when it names nothing resumable. */
export function liveAgentResumeRecord(args: {
  row: AgentStatusIpcPayload
  worktreeId: string
  launchConfig: SleepingAgentLaunchConfig | undefined
  existing: SleepingAgentSessionRecord | undefined
  now: number
}): SleepingAgentSessionRecord | null {
  const { row } = args
  const identity =
    row.providerSessionOnly || row.structuredHost
      ? null
      : resumableIdentity(row.agentType, row.providerSession)
  const pane = parsePaneKey(row.paneKey)
  if (!identity || !pane) {
    return null
  }
  return {
    paneKey: row.paneKey,
    tabId: pane.tabId,
    worktreeId: args.worktreeId,
    agent: identity.agent,
    providerSession: identity.providerSession,
    connectionId: row.connectionId,
    // Why: as in the renderer's anchor, a resume re-enters the session; it never replays a prompt.
    prompt: '',
    state: row.state,
    capturedAt: args.existing?.capturedAt ?? args.now,
    updatedAt: args.now,
    ...(args.launchConfig ? { launchConfig: args.launchConfig } : {}),
    origin: 'live'
  }
}

/** Same target, state and placement: a rewrite would only churn the session file. */
export function sameAgentResumeRecord(
  left: SleepingAgentSessionRecord | undefined,
  right: SleepingAgentSessionRecord
): boolean {
  return (
    left !== undefined &&
    left.origin === right.origin &&
    left.agent === right.agent &&
    agentProviderSessionsEqual(left.agent, left.providerSession, right.providerSession) &&
    left.state === right.state &&
    left.tabId === right.tabId &&
    left.worktreeId === right.worktreeId &&
    (left.connectionId ?? null) === (right.connectionId ?? null) &&
    JSON.stringify(left.launchConfig ?? null) === JSON.stringify(right.launchConfig ?? null)
  )
}

/** A sleep or quit capture is the pane's only resume handle once its live row is gone. */
export function isDurableAgentResumeRecord(
  record: SleepingAgentSessionRecord | undefined
): boolean {
  return record?.origin === 'worktree-sleep' || record?.origin === 'quit'
}
