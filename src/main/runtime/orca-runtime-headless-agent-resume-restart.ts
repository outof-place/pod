// Fork-only (Pod): headless agent resume across a host restart. A pane whose agent can resume says
// so until its tab is shown; an agent that outlived the restart shows its last state, marked as from
// before it, until its screen or its next event settles it; a ⌘⇧N agent that left no session comes
// back as a new one the client can announce.
import type { RuntimeMobileSessionAgentResume } from '../../shared/runtime-mobile-session-tab-contracts'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import { parseExecutionHostId } from '../../shared/execution-host'
import {
  agentStatusBeforeRestart,
  checkStateBeforeRestartOnScreen,
  pendingPaneAgentResume,
  restoredAgentRowBeforeRestart,
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

  /** Also, for a pane still waiting for its terminal, the resume it will run. */
  override getPaneAgentResume(
    paneKey: string,
    pane?: { worktreeId: string; pending: boolean }
  ): RuntimeMobileSessionAgentResume | undefined {
    const started = super.getPaneAgentResume(paneKey)
    if (started || !pane?.pending || !this.handlesRestartWithoutRenderer()) {
      return started
    }
    const record = this.getWorkspaceSessionForWorktree(pane.worktreeId)
      ?.sleepingAgentSessionsByPaneKey?.[paneKey]
    return pendingPaneAgentResume({
      // Why: a record another worktree left under this key is not this pane's agent.
      record: record?.worktreeId === pane.worktreeId ? record : undefined,
      rows: this.getAgentStatusRowsForPane(paneKey),
      connectionId: this.agentResumeConnectionId(pane.worktreeId)
    })
  }

  /** A live tab whose agent outlived the restart shows the state hydrated from disk, marked, where
   *  the upstream projection drops it (the turn may have moved on while no host listened). */
  protected override toMobileSessionTabsResult(
    snapshot: RuntimeMobileSessionTabsSnapshot
  ): RuntimeMobileSessionTabsResult {
    const result = super.toMobileSessionTabsResult(snapshot)
    if (!this.handlesRestartWithoutRenderer()) {
      return result
    }
    let changed = false
    const tabs = result.tabs.map((tab) => {
      const kept =
        tab.type === 'terminal' && tab.status === 'ready'
          ? this.keptAgentBeforeRestart(`${tab.parentTabId}:${tab.leafId}`)
          : undefined
      if (!kept || tab.type !== 'terminal') {
        return tab
      }
      changed = true
      return {
        ...tab,
        agentStatus: agentStatusBeforeRestart(tab.agentStatus, kept.row, kept.confirmed)
      }
    })
    return changed ? { ...result, tabs } : result
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
    const kept = this.keptAgentBeforeRestart(paneKey)
    const pty = Array.from(this.ptysById.values()).find((record) => record.paneKey === paneKey)
    if (!kept || kept.confirmed || !pty) {
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
      ? checkStateBeforeRestartOnScreen(kept.state, lines.join('\n'))
      : null
    // Why again: the agent may have spoken while the screen was read, replacing the restored row.
    if (check && this.keptAgentBeforeRestart(paneKey)) {
      this.agentStateScreenChecks.set(paneKey, check)
      this.notifyMobileSessionTabsChanged(worktreeId)
    }
  }

  private keptAgentBeforeRestart(paneKey: string) {
    const check = this.agentStateScreenChecks.get(paneKey)
    const restored =
      check === 'stale' || !this.handlesRestartWithoutRenderer()
        ? undefined
        : restoredAgentRowBeforeRestart(this.getAgentStatusRowsForPane(paneKey))
    return restored ? { ...restored, confirmed: check === 'confirmed' } : undefined
  }

  // Why: with a window the renderer restores its panes and their status; none of this applies.
  private handlesRestartWithoutRenderer(): boolean {
    return isHeadlessAgentResumeEnabled() && !this.getAvailableAuthoritativeWindow()
  }

  private agentResumeConnectionId(worktreeId: string): string | null {
    const host = this.tryGetWorkspaceSessionHostIdForWorktree(worktreeId)
    const parsed = host ? parseExecutionHostId(host) : null
    return parsed?.kind === 'ssh' ? parsed.targetId : null
  }
}
