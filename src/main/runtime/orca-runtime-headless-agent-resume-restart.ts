// Fork-only (Pod): headless agent resume across a host restart. A pane whose agent can resume says
// so until its tab is shown; an agent that outlived the restart keeps its last state,
// marked as from before it, until its screen or its next event settles it; a ⌘⇧N agent that left
// no session comes back as a new one the client can announce.
import type { RuntimeMobileSessionAgentResume } from '../../shared/runtime-mobile-session-tab-contracts'
import { parseExecutionHostId } from '../../shared/execution-host'
import {
  checkStateBeforeRestartOnScreen,
  keptPaneAgentResume,
  pendingPaneAgentResume,
  type AgentStateScreenCheck
} from './agent-resume-before-restart'
import {
  isHeadlessAgentResumeEnabled,
  OrcaRuntimeWithHeadlessAgentResume,
  type PaneAgentResumePlan
} from './orca-runtime-headless-agent-resume'

export class OrcaRuntimeWithHeadlessAgentResumeRestart extends OrcaRuntimeWithHeadlessAgentResume {
  private readonly agentStateScreenChecks = new Map<string, AgentStateScreenCheck>()

  override noteHeadlessAgentStatus(paneKey: string): void {
    this.agentStateScreenChecks.delete(paneKey)
    super.noteHeadlessAgentStatus(paneKey)
  }

  /** Also, for a pane still waiting for its terminal, the resume it will run; and for an agent
   *  that outlived the host's restart, the state it was last seen in. */
  override getPaneAgentResume(
    paneKey: string,
    pane?: { worktreeId: string; pending: boolean }
  ): RuntimeMobileSessionAgentResume | undefined {
    const started = super.getPaneAgentResume(paneKey)
    if (started || !pane || !isHeadlessAgentResumeEnabled()) {
      return started
    }
    // Why: with a window the renderer restores its panes; nothing here would happen.
    if (this.getAvailableAuthoritativeWindow()) {
      return undefined
    }
    const rows = this.getAgentStatusRowsForPane(paneKey)
    if (!pane.pending) {
      return keptPaneAgentResume(rows, this.agentStateScreenChecks.get(paneKey))
    }
    const record = this.getWorkspaceSessionForWorktree(pane.worktreeId)
      ?.sleepingAgentSessionsByPaneKey?.[paneKey]
    return pendingPaneAgentResume({
      // Why: a record another worktree left under this key is not this pane's agent.
      record: record?.worktreeId === pane.worktreeId ? record : undefined,
      rows,
      connectionId: this.agentResumeConnectionId(pane.worktreeId)
    })
  }

  /** A ⌘⇧N agent that ran in this pane but left no session to resume starts afresh; say so. */
  protected restartedPaneAgentPlan(
    launchAgent: string | undefined,
    startedAgent: boolean,
    hadTerminal: boolean
  ): PaneAgentResumePlan | null {
    return launchAgent && startedAgent && hadTerminal && isHeadlessAgentResumeEnabled()
      ? { outcome: { agent: launchAgent, outcome: 'restarted' }, startup: null }
      : null
  }

  /** A shown tab whose agent outlived the restart: its screen confirms the old state or retires it. */
  protected async confirmAgentStateBeforeRestart(
    worktreeId: string,
    paneKey: string
  ): Promise<void> {
    const kept = this.getPaneAgentResume(paneKey, { worktreeId, pending: false })
    const pty = Array.from(this.ptysById.values()).find((record) => record.paneKey === paneKey)
    if (kept?.outcome !== 'kept' || kept.confirmed || !kept.stateBeforeRestart || !pty) {
      return
    }
    const visible = await this.readVisibleTerminalState(pty.ptyId).catch(() => null)
    const lines =
      visible?.lines ??
      (
        await this.readProviderTerminalTailLines(pty.ptyId, undefined, {
          visibleScreenOnly: true
        }).catch(() => null)
      )?.lines
    const check = lines?.length
      ? checkStateBeforeRestartOnScreen(kept.stateBeforeRestart, lines.join('\n'))
      : null
    // Why again: the agent may have spoken while the screen was read, replacing the restored row.
    const still = this.getPaneAgentResume(paneKey, { worktreeId, pending: false })
    if (check && still?.outcome === 'kept') {
      this.agentStateScreenChecks.set(paneKey, check)
      this.notifyMobileSessionTabsChanged(worktreeId)
    }
  }

  private agentResumeConnectionId(worktreeId: string): string | null {
    const host = this.tryGetWorkspaceSessionHostIdForWorktree(worktreeId)
    const parsed = host ? parseExecutionHostId(host) : null
    return parsed?.kind === 'ssh' ? parsed.targetId : null
  }
}
