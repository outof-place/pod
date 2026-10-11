// The renderer's per-update `live` resume anchors, kept by a host with no renderer and written in
// batches: a busy agent emits many hook events, but the record changes only per turn.
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import {
  agentProviderSessionsEqual,
  type SleepingAgentLaunchConfig,
  type SleepingAgentSessionRecord
} from '../../shared/agent-session-resume'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { parsePaneKey } from '../../shared/stable-pane-id'
import {
  isDurableAgentResumeRecord,
  liveAgentResumeRecord,
  sameAgentResumeRecord
} from './agent-resume-records'

export const HEADLESS_AGENT_RESUME_ANCHOR_FLUSH_MS = 1000

export type HeadlessAgentResumeAnchorHost = {
  hasRenderer(): boolean
  rowsForPane(paneKey: string): AgentStatusIpcPayload[]
  allRows(): AgentStatusIpcPayload[]
  sessionFor(worktreeId: string): WorkspaceSessionState | null
  launchConfigFor(paneKey: string): SleepingAgentLaunchConfig | undefined
  writeRecords(
    worktreeId: string,
    session: WorkspaceSessionState,
    changes: Record<string, SleepingAgentSessionRecord | null>
  ): void
}

export class HeadlessAgentResumeAnchors {
  private readonly pending = new Set<string>()
  private readonly endedSessionIdByPaneKey = new Map<string, string>()
  private timer: ReturnType<typeof setTimeout> | null = null
  /** Session-file writes made, for the write-rate budget. */
  writes = 0

  constructor(
    private readonly host: HeadlessAgentResumeAnchorHost,
    private readonly flushDelayMs = HEADLESS_AGENT_RESUME_ANCHOR_FLUSH_MS
  ) {}

  /** A pane's status rows changed; its anchor is brought in step at the next flush. */
  note(paneKey: string): void {
    this.pending.add(paneKey)
    // Why a fixed delay, not a debounce reset per event: a busy agent would otherwise never flush.
    this.timer ??= setTimeout(() => this.flush(), this.flushDelayMs)
    this.timer.unref?.()
  }

  /** Claude's process-ending SessionEnd: that session must not be resumed into its old pane. */
  noteSessionEnded(paneKey: string, providerSessionId: string): void {
    this.endedSessionIdByPaneKey.set(paneKey, providerSessionId)
    this.note(paneKey)
  }

  /** Every pane at once and immediately; startup runs it before reaping rows whose PTY died. */
  syncAll(): void {
    for (const row of this.host.allRows()) {
      this.pending.add(row.paneKey)
    }
    this.flush()
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const paneKeys = [...this.pending]
    this.pending.clear()
    // Why: a renderer writes its own anchors; two writers would race on the session.
    if (paneKeys.length === 0 || this.host.hasRenderer()) {
      return
    }
    const changesByWorktree = new Map<
      string,
      { session: WorkspaceSessionState; changes: Record<string, SleepingAgentSessionRecord | null> }
    >()
    for (const paneKey of paneKeys) {
      const rows = this.host.rowsForPane(paneKey)
      const worktreeId = rows.find((row) => row.worktreeId)?.worktreeId
      const batch = worktreeId ? changesByWorktree.get(worktreeId) : undefined
      const session = batch?.session ?? (worktreeId ? this.host.sessionFor(worktreeId) : null)
      const tabId = parsePaneKey(paneKey)?.tabId
      if (
        !worktreeId ||
        !session ||
        !session.tabsByWorktree[worktreeId]?.some((tab) => tab.id === tabId)
      ) {
        continue
      }
      const change = this.anchorChange(paneKey, worktreeId, rows, session)
      if (change !== undefined) {
        const entry = batch ?? { session, changes: {} }
        entry.changes[paneKey] = change
        changesByWorktree.set(worktreeId, entry)
      }
    }
    for (const [worktreeId, { session, changes }] of changesByWorktree) {
      this.host.writeRecords(worktreeId, session, changes)
      this.writes += 1
    }
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.pending.clear()
  }

  /** The record to write (null deletes), or undefined when the pane's anchor is already right. */
  private anchorChange(
    paneKey: string,
    worktreeId: string,
    rows: AgentStatusIpcPayload[],
    session: WorkspaceSessionState
  ): SleepingAgentSessionRecord | null | undefined {
    const existing = session.sleepingAgentSessionsByPaneKey?.[paneKey]
    const ended = this.endedSessionIdByPaneKey.get(paneKey)
    const next = rows
      .map((row) =>
        liveAgentResumeRecord({
          row,
          worktreeId,
          launchConfig: this.host.launchConfigFor(paneKey),
          existing,
          now: Date.now()
        })
      )
      .find(
        (record): record is SleepingAgentSessionRecord =>
          record !== null && record.providerSession.id !== ended
      )
    if (next) {
      this.endedSessionIdByPaneKey.delete(paneKey)
      const keepsDurable =
        isDurableAgentResumeRecord(existing) &&
        agentProviderSessionsEqual(next.agent, existing?.providerSession, next.providerSession)
      return keepsDurable || sameAgentResumeRecord(existing, next) ? undefined : next
    }
    // Why: a remnant row or a SessionEnd means the agent exited under its shell.
    const exited =
      existing?.origin === 'live' &&
      (existing.providerSession.id === ended ||
        rows.some(
          (row) =>
            row.providerSessionOnly === true &&
            row.agentType === existing.agent &&
            agentProviderSessionsEqual(
              existing.agent,
              row.providerSession,
              existing.providerSession
            )
        ))
    return exited ? null : undefined
  }
}
