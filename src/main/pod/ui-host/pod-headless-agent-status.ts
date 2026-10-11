// Fork-only (Pod): the host-side duty of the main window's hook listener
// (main-window-agent-status.ts) that the headless one-app runtime keeps while no window is open:
// the branch rename on an agent's first work. The rest of that listener feeds a renderer.
import { agentHookServer } from '../../agent-hooks/server'
import { maybeAutoRenameBranchOnFirstWorkFromHook } from '../../startup/branch-rename-hook'
import { mainProcessState as state } from '../../startup/main-process-state'

export function installPodHeadlessAgentStatus(): () => void {
  return agentHookServer.subscribeEnrichedStatus((event) => {
    // An open window's listener does it then.
    if (state.mainWindow && !state.mainWindow.isDestroyed()) {
      return
    }
    // The same events the window's listener leaves alone.
    if (event.structuredHost || event.providerSessionOnly || event.restoredUnconfirmed) {
      return
    }
    maybeAutoRenameBranchOnFirstWorkFromHook({
      paneKey: event.paneKey,
      tabId: event.tabId,
      worktreeId: event.worktreeId,
      payload: event.payload,
      isReplay: event.isReplay
    })
  })
}
