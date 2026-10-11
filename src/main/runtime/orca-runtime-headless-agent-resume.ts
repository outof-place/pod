import type {
  AgentProviderSessionMetadata,
  ResumableTuiAgent,
  SleepingAgentLaunchConfig,
  SleepingAgentSessionRecord
} from '../../shared/agent-session-resume'
import { agentProviderSessionsEqual } from '../../shared/agent-session-resume'
import type { RuntimeMobileSessionAgentResume } from '../../shared/runtime-mobile-session-tab-contracts'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { WorktreeStartupLaunch } from '../../shared/worktree/launch-types'
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
  paneAgentWithoutResume,
  resolvePaneAgentResume
} from './agent-resume-records'
import { HeadlessAgentResumeAnchors } from './headless-agent-resume-anchors'
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

/** A pane's start: the resume to run, or none when its agent cannot come back (`unavailable`). */
export type PaneAgentResumePlan = {
  outcome: RuntimeMobileSessionAgentResume
  startup: PaneAgentResumeStartup | null
}

/** Kill switch: ORCA_HEADLESS_AGENT_RESUME=0 restores the shell-only headless behavior. */
export function isHeadlessAgentResumeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ORCA_HEADLESS_AGENT_RESUME !== '0'
}

/** Terminal-agent resume for a host with no renderer: the records the renderer keeps on desktop
 *  (live anchors, worktree-sleep captures) and the `--resume` its cold restore issues. */
export class OrcaRuntimeWithHeadlessAgentResume extends OrcaRuntimeWithResolveWaiter {
  private agentResumeAnchors: HeadlessAgentResumeAnchors | null = null
  private readonly paneMaterializationsInFlight = new Map<string, Promise<void>>()
  private readonly agentResumeByPaneKey = new Map<string, RuntimeMobileSessionAgentResume>()

  /** A pane's status rows changed; its `live` anchor follows at the next batched write. */
  noteHeadlessAgentStatus(paneKey: string): void {
    if (isHeadlessAgentResumeEnabled()) {
      this.agentResumeByPaneKey.delete(paneKey)
      this.headlessAgentResumeAnchors.note(paneKey)
    }
  }

  /** Claude's process-ending SessionEnd retires the pane's anchor for that session. */
  noteHeadlessAgentSessionEnded(paneKey: string, providerSessionId: string): void {
    if (isHeadlessAgentResumeEnabled()) {
      this.headlessAgentResumeAnchors.noteSessionEnded(paneKey, providerSessionId)
    }
  }

  /** Every pane's anchor, written now; run before startup reaping drops rows whose PTY died. */
  syncHeadlessAgentResumeAnchors(): void {
    if (isHeadlessAgentResumeEnabled()) {
      this.headlessAgentResumeAnchors.syncAll()
    }
  }

  /** Session-file writes the anchors made, for the write-rate budget. */
  getHeadlessAgentResumeAnchorWrites(): number {
    return this.agentResumeAnchors?.writes ?? 0
  }

  /** What the last start of a pane did about its agent, for clients to show. */
  getPaneAgentResume(paneKey: string): RuntimeMobileSessionAgentResume | undefined {
    return this.agentResumeByPaneKey.get(paneKey)
  }

  /** A start already running for this pane; a second open waits for it instead of spawning. */
  protected joinPaneMaterialization(worktreeId: string, paneKey: string): Promise<void> | null {
    return this.paneMaterializationsInFlight.get(`${worktreeId}\0${paneKey}`) ?? null
  }

  protected beginPaneMaterialization(worktreeId: string, paneKey: string): () => void {
    const key = `${worktreeId}\0${paneKey}`
    let finish = (): void => {}
    this.paneMaterializationsInFlight.set(
      key,
      new Promise<void>((resolve) => {
        finish = () => {
          this.paneMaterializationsInFlight.delete(key)
          resolve()
        }
      })
    )
    return finish
  }

  /** What a pane started again resumes; null when no agent ran there (the caller's own launch). */
  protected async resolvePaneAgentResumeStartup(
    worktreeId: string,
    paneKey: string
  ): Promise<PaneAgentResumePlan | null> {
    const settings = this.store?.getSettings()
    const record =
      this.getWorkspaceSessionForWorktree(worktreeId)?.sleepingAgentSessionsByPaneKey?.[paneKey]
    const rows = this.getAgentStatusRowsForPane(paneKey)
    if (!isHeadlessAgentResumeEnabled() || !settings || (!record && rows.length === 0)) {
      return null
    }
    const workspace = await this.resolveTerminalWorkspaceLaunchScope(`id:${worktreeId}`)
    const resume = resolvePaneAgentResume({
      record,
      rows,
      connectionId: workspace.connectionId ?? null
    })
    const platform = this.getAgentLaunchPlatformForWorkspace(workspace)
    const isRemote = Boolean(workspace.connectionId)
    const launchConfig = resume?.launchConfig
    const plan =
      resume && isTuiAgentEnabled(resume.agent, settings.disabledTuiAgents)
        ? buildAgentResumeStartupPlan({
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
        : null
    if (!resume || !plan) {
      // Why: an agent ran here and cannot come back; the client says so over the shell.
      const lost = resume?.agent ?? paneAgentWithoutResume({ record, rows })
      return lost ? { outcome: { agent: lost, outcome: 'unavailable' }, startup: null } : null
    }
    return {
      outcome: { agent: resume.agent, outcome: 'resumed' },
      startup: {
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
  }

  /** After the pane started: publish what happened to its agent and spend a used sleep record. */
  protected settlePaneAgentResume(
    worktreeId: string,
    paneKey: string,
    plan: PaneAgentResumePlan | null
  ): void {
    if (!plan) {
      this.agentResumeByPaneKey.delete(paneKey)
      return
    }
    this.agentResumeByPaneKey.set(paneKey, plan.outcome)
    if (plan.startup?.record) {
      this.consumeAgentResumeRecord(worktreeId, plan.startup.record)
    }
    this.notifyMobileSessionTabsChanged(worktreeId)
  }

  /** A sleep or quit capture is spent by its resume; a live anchor stays and follows the agent's rows. */
  private consumeAgentResumeRecord(worktreeId: string, record: SleepingAgentSessionRecord): void {
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

  /** A closed tab is never resumed; its panes' records go with it. */
  protected forgetAgentResumeForTab(worktreeId: string, tabId: string): void {
    for (const paneKey of this.agentResumeByPaneKey.keys()) {
      if (paneKey.startsWith(`${tabId}:`)) {
        this.agentResumeByPaneKey.delete(paneKey)
      }
    }
    const session = this.getWorkspaceSessionForWorktree(worktreeId)
    if (!session || this.getAvailableAuthoritativeWindow()) {
      return
    }
    const closed = Object.keys(session.sleepingAgentSessionsByPaneKey ?? {}).filter((paneKey) =>
      paneKey.startsWith(`${tabId}:`)
    )
    if (closed.length > 0) {
      this.writeAgentResumeRecords(
        worktreeId,
        session,
        Object.fromEntries(closed.map((paneKey) => [paneKey, null]))
      )
    }
  }

  /** `worktree.sleep` with no renderer: keep each agent's resume handle, then stop the PTYs. */
  protected async sleepWorktreeTerminalsWithoutRenderer(worktreeId: string): Promise<void> {
    if (!isHeadlessAgentResumeEnabled()) {
      return
    }
    this.headlessAgentResumeAnchors.flush()
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
        // Why: the pane's last start is over; until it starts again it waits to resume.
        this.agentResumeByPaneKey.delete(pty.paneKey)
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

  private get headlessAgentResumeAnchors(): HeadlessAgentResumeAnchors {
    this.agentResumeAnchors ??= new HeadlessAgentResumeAnchors({
      hasRenderer: () => Boolean(this.getAvailableAuthoritativeWindow()),
      rowsForPane: (paneKey) => this.getAgentStatusRowsForPane(paneKey),
      allRows: () => this.getAgentProviderSessionRows(),
      sessionFor: (worktreeId) => this.getWorkspaceSessionForWorktree(worktreeId),
      launchConfigFor: (paneKey) => this.findPtyLaunchConfigForPaneKey(paneKey),
      writeRecords: (worktreeId, session, changes) =>
        this.writeAgentResumeRecords(worktreeId, session, changes)
    })
    return this.agentResumeAnchors
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
