// Fork-only (Pod): what a client shows for a pane's agent across a host restart, before the agent
// has spoken again: the resume a pending pane will run, or the state an agent that ran on through
// the restart was last seen in. Never shown as live truth: the turn may have moved on meanwhile.
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import {
  agentProviderSessionsEqual,
  normalizeAgentProviderSession,
  type SleepingAgentSessionRecord
} from '../../shared/agent-session-resume'
import type { RuntimeMobileSessionAgentResume } from '../../shared/runtime-mobile-session-tab-contracts'
import { resolvePaneAgentResume } from './agent-resume-records'
import {
  detectTerminalWaitBlockedReason,
  isKnownReadyPromptSettled
} from './terminal-wait-detection'

export type AgentStateBeforeRestart = NonNullable<
  RuntimeMobileSessionAgentResume['stateBeforeRestart']
>

/** The screen at a tab's activation, against the state its agent had before the restart. */
export type AgentStateScreenCheck = 'confirmed' | 'stale'

function asStateBeforeRestart(state: string | undefined): AgentStateBeforeRestart | undefined {
  return state === 'working' || state === 'waiting' || state === 'blocked' ? state : undefined
}

/** A pane still waiting for its terminal: the agent its tab's activation will resume. */
export function pendingPaneAgentResume(args: {
  record: SleepingAgentSessionRecord | undefined
  rows: readonly AgentStatusIpcPayload[]
  connectionId: string | null
}): RuntimeMobileSessionAgentResume | undefined {
  if (!args.record && args.rows.length === 0) {
    return undefined
  }
  const resume = resolvePaneAgentResume(args)
  if (!resume) {
    return undefined
  }
  const row = args.rows.find(
    (candidate) =>
      !candidate.providerSessionOnly &&
      candidate.agentType === resume.agent &&
      agentProviderSessionsEqual(
        resume.agent,
        normalizeAgentProviderSession(candidate.providerSession) ?? undefined,
        resume.providerSession
      )
  )
  const before = asStateBeforeRestart(resume.record?.state ?? row?.state ?? args.record?.state)
  return {
    agent: resume.agent,
    outcome: 'pending',
    ...(before ? { stateBeforeRestart: before } : {})
  }
}

/** An agent whose terminal outlived the host's restart, still in the state hydrated from disk. */
export function keptPaneAgentResume(
  rows: readonly AgentStatusIpcPayload[],
  check: AgentStateScreenCheck | undefined
): RuntimeMobileSessionAgentResume | undefined {
  const row = rows.find(
    (candidate) =>
      candidate.restoredUnconfirmed === true &&
      !candidate.providerSessionOnly &&
      !candidate.structuredHost &&
      candidate.agentType !== undefined &&
      candidate.agentType !== 'unknown'
  )
  const before = asStateBeforeRestart(row?.state)
  if (!row?.agentType || !before || check === 'stale') {
    return undefined
  }
  return {
    agent: row.agentType,
    outcome: 'kept',
    stateBeforeRestart: before,
    ...(check === 'confirmed' ? { confirmed: true as const } : {})
  }
}

/** Null when the screen proves neither: the marker stays until the agent's next event. */
export function checkStateBeforeRestartOnScreen(
  state: AgentStateBeforeRestart,
  screen: string
): AgentStateScreenCheck | null {
  const blocked = detectTerminalWaitBlockedReason(screen) !== null
  if (!blocked && isKnownReadyPromptSettled(screen)) {
    return 'stale'
  }
  // Why a turn is never confirmed here: its screen proves nothing; its next hook event does.
  if (state === 'working') {
    return blocked ? 'stale' : null
  }
  return blocked ? 'confirmed' : null
}
