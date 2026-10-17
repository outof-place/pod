// Fork-only (Pod): a failed shell's kept pane starts again only as a plain shell, through Restart.
// Its agent resume record and the tab's launch agent would start the agent again on the next spawn,
// with Restart or after Pod restarts (the exit map is in memory), so both go when the exit is kept.
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { PodUiHostPaneRestartRequest } from '../../../shared/pod-ui-host-pane-restart'

type RetainedExitNotice = (window: unknown, pane: PodUiHostPaneRestartRequest) => void

// Why a registry: the runtime stays Electron-free; main installs the IPC (pod-ui-host-pane-restart.ts).
let retainedExitNotice: RetainedExitNotice | null = null

export function setPodRendererRetainedExitNotice(notice: RetainedExitNotice | null): void {
  retainedExitNotice = notice
}

/** The runtime members this uses; OrcaRuntimeService passes itself. */
export type PodRetainedPaneResumeHost = {
  getAvailableAuthoritativeWindow(): unknown
  forgetAgentResumeForPane(worktreeId: string, paneKey: string): void
  getWorkspaceSessionForWorktree(worktreeId: string): WorkspaceSessionState | null | undefined
  setWorkspaceSessionForWorktree(worktreeId: string, session: WorkspaceSessionState): void
}

export function forgetPodRetainedPaneResume(
  host: PodRetainedPaneResumeHost,
  surface: { worktreeId: string; parentTabId: string; leafId: string }
): void {
  host.forgetAgentResumeForPane(surface.worktreeId, `${surface.parentTabId}:${surface.leafId}`)
  const window = host.getAvailableAuthoritativeWindow()
  if (window) {
    // Why: with a window its renderer keeps the resume records and spawns the pane.
    retainedExitNotice?.(window, {
      worktreeId: surface.worktreeId,
      tabId: surface.parentTabId,
      leafId: surface.leafId
    })
    return
  }
  forgetHeadlessLaunchAgent(host, surface)
}

// Why the whole tab's: activation starts the tab's launch agent in any of its pending panes; only a
// launch laid out in another pane keeps it.
function forgetHeadlessLaunchAgent(
  host: PodRetainedPaneResumeHost,
  surface: { worktreeId: string; parentTabId: string; leafId: string }
): void {
  const session = host.getWorkspaceSessionForWorktree(surface.worktreeId)
  const tabs = session?.tabsByWorktree[surface.worktreeId]
  const tab = tabs?.find((candidate) => candidate.id === surface.parentTabId)
  if (!session || !tabs || !tab?.launchAgent) {
    return
  }
  if (tab.agentLaunchPane && tab.agentLaunchPane.leafId !== surface.leafId) {
    return
  }
  const { launchAgent: _dropped, ...rest } = tab
  host.setWorkspaceSessionForWorktree(surface.worktreeId, {
    ...session,
    tabsByWorktree: {
      ...session.tabsByWorktree,
      [surface.worktreeId]: tabs.map((candidate) => (candidate === tab ? rest : candidate))
    }
  })
}
