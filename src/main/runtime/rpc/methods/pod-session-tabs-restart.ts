// Fork-only (Pod): Restart for the native "Terminal exited" overlay (pod-terminal-exit-restart.ts).
import { defineMethod } from '../core'
import { SessionTabsRestartTerminalParams } from '../../../../shared/rpc-contract/pod-session-tabs-restart-params'

export const POD_SESSION_TAB_RESTART_METHODS = [
  // Why workspace: the same callers that open and close session tabs restart them.
  defineMethod({
    name: 'session.tabs.restartTerminal',
    permission: 'workspace',
    params: SessionTabsRestartTerminalParams,
    handler: (params, { runtime }) =>
      runtime.restartExitedMobileSessionTerminal(params.worktree, params.tabId, params.leafId)
  })
]
