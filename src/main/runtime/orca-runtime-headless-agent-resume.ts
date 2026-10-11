import type {
  AgentProviderSessionMetadata,
  ResumableTuiAgent,
  SleepingAgentLaunchConfig,
  SleepingAgentSessionRecord
} from '../../shared/agent-session-resume'
import { agentProviderSessionsEqual } from '../../shared/agent-session-resume'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { WorktreeStartupLaunch } from '../../shared/worktree/launch-types'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { isTuiAgentEnabled } from '../../shared/tui-agent-selection'
import { buildAgentResumeStartupPlan } from '../../shared/tui-agent-startup'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../shared/tui-agent-launch-defaults'
import { resolveLocalWindowsAgentStartupShell } from '../../shared/windows-terminal-shell'
import {
  isDurableAgentResumeRecord,
  liveAgentResumeRecord,
  resolvePaneAgentResume,
  sameAgentResumeRecord
} from './agent-resume-records'
import { OrcaRuntimeWithResolveWaiter } from './orca-runtime-resolve-waiter'

export type PaneAgentResumeStartup = {
  agent: ResumableTuiAgent
  providerSession: AgentProviderSessionMetadata
  record: SleepingAgentSessionRecord | null
  command: string
  env?: Record<string, string>
  launchConfig?: SleepingAgentLaunchConfig
  startupCommandDelivery?: WorktreeStartupLaunch['startupCommandDelivery']
}

/** Terminal-agent resume for a host with no renderer: the records the renderer keeps on desktop
 *  (live anchors, worktree-sleep captures) and the `--resume` its cold restore issues. */
export class OrcaRuntimeWithHeadlessAgentResume extends OrcaRuntimeWithResolveWaiter {
  /** Keeps a pane's `live` anchor in step with its status rows, as the renderer does per update. */
  syncHeadlessAgentResumeAnchor(paneKey: string): void {
    // Why: a renderer writes its own anchors; two writers would race on the session.
    if (this.getAvailableAuthoritativeWindow()) {
      return
    }
    const rows = this.getAgentStatusRowsForPane(paneKey)
    const worktreeId = rows.find((row) => row.worktreeId)?.worktreeId
    const session = worktreeId ? this.getWorkspaceSessionForWorktree(worktreeId) : null
    const tabId = parsePaneKey(paneKey)?.tabId
    if (
      !worktreeId ||
      !session ||
      !session.tabsByWorktree[worktreeId]?.some((t) => t.id === tabId)
    ) {
      return
    }
    const existing = session.sleepingAgentSessionsByPaneKey?.[paneKey]
    const launchConfig = this.findPtyLaunchConfigForPaneKey(paneKey)
    const next = rows
      .map((row) =>
        liveAgentResumeRecord({ row, worktreeId, launchConfig, existing, now: Date.now() })
      )
      .find((record) => record !== null)
    if (!next) {
      // Why: a remnant row means the agent exited under its shell; its anchor must not resume it.
      const exited =
        existing?.origin === 'live' &&
        rows.some(
          (row) =>
            row.providerSessionOnly === true &&
            row.agentType === existing.agent &&
            agentProviderSessionsEqual(
              existing.agent,
              row.providerSession,
              existing.providerSession
            )
        )
      if (exited) {
        this.writeAgentResumeRecords(worktreeId, session, { [paneKey]: null })
      }
      return
    }
    const keepsDurable =
      isDurableAgentResumeRecord(existing) &&
      agentProviderSessionsEqual(next.agent, existing?.providerSession, next.providerSession)
    if (keepsDurable || sameAgentResumeRecord(existing, next)) {
      return
    }
    this.writeAgentResumeRecords(worktreeId, session, { [paneKey]: next })
  }

  /** Every pane's anchor at once; run before startup reaping drops rows whose PTY died with the daemon. */
  syncHeadlessAgentResumeAnchors(): void {
    const paneKeys = new Set(this.getAgentProviderSessionRows().map((row) => row.paneKey))
    for (const paneKey of paneKeys) {
      this.syncHeadlessAgentResumeAnchor(paneKey)
    }
  }

  /** What a pane started again resumes, or null for a plain (or freshly launched) terminal. */
  protected async resolvePaneAgentResumeStartup(
    worktreeId: string,
    paneKey: string
  ): Promise<PaneAgentResumeStartup | null> {
    const settings = this.store?.getSettings()
    const record =
      this.getWorkspaceSessionForWorktree(worktreeId)?.sleepingAgentSessionsByPaneKey?.[paneKey]
    const rows = this.getAgentStatusRowsForPane(paneKey)
    if (!settings || (!record && rows.length === 0)) {
      return null
    }
    const workspace = await this.resolveTerminalWorkspaceLaunchScope(`id:${worktreeId}`)
    const resume = resolvePaneAgentResume({
      record,
      rows,
      connectionId: workspace.connectionId ?? null
    })
    if (!resume || !isTuiAgentEnabled(resume.agent, settings.disabledTuiAgents)) {
      return null
    }
    const platform = this.getAgentLaunchPlatformForWorkspace(workspace)
    const isRemote = Boolean(workspace.connectionId)
    const { launchConfig } = resume
    const plan = buildAgentResumeStartupPlan({
      agent: resume.agent,
      providerSession: resume.providerSession,
      cmdOverrides: settings.agentCmdOverrides ?? {},
      agentArgs: launchConfig
        ? launchConfig.agentArgs
        : resolveTuiAgentLaunchArgs(resume.agent, settings.agentDefaultArgs),
      agentEnv: launchConfig
        ? launchConfig.agentEnv
        : resolveTuiAgentLaunchEnv(resume.agent, settings.agentDefaultEnv),
      ...(launchConfig?.agentCommand ? { agentCommand: launchConfig.agentCommand } : {}),
      ...(launchConfig?.ompResumeFilePath
        ? { ompResumeFilePath: launchConfig.ompResumeFilePath }
        : {}),
      platform,
      shell: resolveLocalWindowsAgentStartupShell({
        platform,
        isRemote,
        terminalWindowsShell: settings.terminalWindowsShell
      }),
      isRemote
    })
    if (!plan) {
      return null
    }
    return {
      agent: resume.agent,
      providerSession: resume.providerSession,
      record: resume.record,
      command: plan.launchCommand,
      ...(plan.env ? { env: plan.env } : {}),
      ...(plan.launchConfig ? { launchConfig: plan.launchConfig } : {}),
      ...(plan.startupCommandDelivery
        ? { startupCommandDelivery: plan.startupCommandDelivery }
        : {})
    }
  }

  /** A sleep or quit capture is spent by its resume; a live anchor stays and follows the agent's rows. */
  protected consumeAgentResumeRecord(worktreeId: string, record: SleepingAgentSessionRecord): void {
    if (!isDurableAgentResumeRecord(record) || this.getAvailableAuthoritativeWindow()) {
      return
    }
    const session = this.getWorkspaceSessionForWorktree(worktreeId)
    const current = session?.sleepingAgentSessionsByPaneKey?.[record.paneKey]
    if (
      session &&
      current?.agent === record.agent &&
      agentProviderSessionsEqual(record.agent, current.providerSession, record.providerSession)
    ) {
      this.writeAgentResumeRecords(worktreeId, session, { [record.paneKey]: null })
    }
  }

  /** `worktree.sleep` with no renderer: keep each agent's resume handle, then stop the PTYs. */
  protected async sleepWorktreeTerminalsWithoutRenderer(worktreeId: string): Promise<void> {
    const session = this.getWorkspaceSessionForWorktree(worktreeId)
    if (session) {
      const captures: Record<string, SleepingAgentSessionRecord> = {}
      const now = Date.now()
      for (const pty of this.ptysById.values()) {
        if (pty.worktreeId !== worktreeId || !pty.paneKey) {
          continue
        }
        const existing = session.sleepingAgentSessionsByPaneKey?.[pty.paneKey]
        const live = this.getAgentStatusRowsForPane(pty.paneKey)
          .map((row) =>
            liveAgentResumeRecord({
              row,
              worktreeId,
              launchConfig: pty.launchConfig ?? undefined,
              existing,
              now
            })
          )
          .find((record) => record !== null)
        if (live) {
          // Why: as the renderer's manual sleep, a finished pane resumes when its tab is opened.
          captures[pty.paneKey] = {
            ...live,
            origin: 'worktree-sleep',
            interrupted: false,
            ...(live.state === 'done' ? { restoreOnTabOpenOnly: true } : {})
          }
        }
      }
      if (Object.keys(captures).length > 0) {
        this.writeAgentResumeRecords(worktreeId, session, captures)
      }
    }
    await this.sleepTerminalsForWorktree(`id:${worktreeId}`)
  }

  private findPtyLaunchConfigForPaneKey(paneKey: string): SleepingAgentLaunchConfig | undefined {
    for (const pty of this.ptysById.values()) {
      if (pty.paneKey === paneKey && pty.launchConfig) {
        return pty.launchConfig
      }
    }
    return undefined
  }

  private writeAgentResumeRecords(
    worktreeId: string,
    session: WorkspaceSessionState,
    changes: Record<string, SleepingAgentSessionRecord | null>
  ): void {
    const records = { ...session.sleepingAgentSessionsByPaneKey }
    for (const [paneKey, record] of Object.entries(changes)) {
      if (record) {
        records[paneKey] = record
      } else {
        delete records[paneKey]
      }
    }
    this.setWorkspaceSessionForWorktree(worktreeId, {
      ...session,
      sleepingAgentSessionsByPaneKey: records
    })
  }
}
