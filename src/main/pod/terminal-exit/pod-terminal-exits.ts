// Fork-only (Pod): a local shell that fails keeps its pane, so a native client can show
// "Terminal exited" with Restart and Close, as the desktop's TerminalProcessExitOverlay does.
import type { RuntimeTerminalExit } from '../../../shared/runtime-mobile-session-tab-contracts'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-session-contracts'

const exits = new Map<string, RuntimeTerminalExit>()

const key = (worktreeId: string, tabId: string, leafId: string): string =>
  `${worktreeId}\0${tabId}\0${leafId}`

/**
 * The desktop's rule (pty-exit-hibernate.ts): a proven exit above 0 of a local shell. -1 means a
 * stop nobody confirmed, and SSH shells keep their own reconnect rules.
 */
export function podRetainsFailedLocalExit(exit: {
  exitCode: number
  local: boolean
  operatorClose: boolean
  processDeathCertified: boolean
}): boolean {
  return exit.local && exit.exitCode > 0 && !exit.operatorClose && exit.processDeathCertified
}

export function recordPodTerminalExit(
  surface: { worktreeId: string; parentTabId: string; leafId: string },
  exit: RuntimeTerminalExit
): void {
  exits.set(key(surface.worktreeId, surface.parentTabId, surface.leafId), exit)
}

export function getPodTerminalExit(
  worktreeId: string,
  tabId: string,
  leafId: string
): RuntimeTerminalExit | undefined {
  return exits.get(key(worktreeId, tabId, leafId))
}

/** Returns whether the leaf had an exit to clear. */
export function clearPodTerminalExit(worktreeId: string, tabId: string, leafId: string): boolean {
  return exits.delete(key(worktreeId, tabId, leafId))
}

/** Each kept pane without a live handle carries its exit to clients. */
export function withPodTerminalExits(
  result: RuntimeMobileSessionTabsResult
): RuntimeMobileSessionTabsResult {
  if (exits.size === 0) {
    return result
  }
  let changed = false
  const tabs = result.tabs.map((tab) => {
    const exit =
      tab.type === 'terminal' && tab.status !== 'ready'
        ? exits.get(key(result.worktree, tab.parentTabId, tab.leafId))
        : undefined
    if (!exit) {
      return tab
    }
    changed = true
    return { ...tab, terminalExit: exit }
  })
  return changed ? { ...result, tabs } : result
}

export function resetPodTerminalExitsForTests(): void {
  exits.clear()
}
