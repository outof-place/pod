// Fork-only (Pod): `pod.terminal.openedBeforeClaudeAccounts`, the runtime form of the classic
// window's `pty:openedBeforeClaudeAccounts` (ipc/pty/ipc/claude-old-terminal.ts), so PodNative can
// show Pod's banner on a Claude pane whose shell predates per-account folders. Read only: it reads
// the daemon that serves the pane and the router's answer the classic banner already uses.
import { defineMethod } from '../../runtime/rpc/core'
import { PodTerminalOpenedBeforeClaudeAccountsParams } from '../../../shared/rpc-contract/pod-claude-old-terminal-params'
import { getClaudeProfileRouter } from '../../claude-accounts/claude-profile-installed-router'
import {
  CLAUDE_ACCOUNT_FUNCTION_DAEMON_PROTOCOL_VERSION,
  CLAUDE_ACCOUNT_FUNCTION_REVERTED_DAEMON_PROTOCOL_VERSION
} from '../../daemon/daemon-protocol-version'
import { isTerminalOnLegacyDaemon } from '../../daemon/daemon-provider-state'

// Same rule as the classic handler: v42 shipped the claude function, only v43 (the revert) lacked it.
function lacksClaudeFunction(protocolVersion: number): boolean {
  return (
    protocolVersion < CLAUDE_ACCOUNT_FUNCTION_DAEMON_PROTOCOL_VERSION ||
    protocolVersion === CLAUDE_ACCOUNT_FUNCTION_REVERTED_DAEMON_PROTOCOL_VERSION
  )
}

export type PodClaudeOldTerminalDeps = {
  ptyIdOf: (terminal: string) => string | null
  onLegacyDaemon: (ptyId: string) => boolean
  systemDefaultRunsAnotherAccount: () => boolean | null
}

export function createPodClaudeOldTerminalMethods(deps?: Partial<PodClaudeOldTerminalDeps>) {
  return [
    defineMethod({
      name: 'pod.terminal.openedBeforeClaudeAccounts',
      permission: 'workspace',
      params: PodTerminalOpenedBeforeClaudeAccountsParams,
      handler: (params, { runtime }): { openedBefore: boolean } => {
        const ptyIdOf =
          deps?.ptyIdOf ??
          ((terminal: string) => runtime.resolveLiveLeafForHandle(terminal)?.ptyId ?? null)
        const onLegacyDaemon =
          deps?.onLegacyDaemon ??
          ((ptyId: string) => isTerminalOnLegacyDaemon(ptyId, lacksClaudeFunction))
        const runsAnother =
          deps?.systemDefaultRunsAnotherAccount ??
          (() => getClaudeProfileRouter()?.systemDefaultRunsAnotherAccount() ?? null)
        const ptyId = ptyIdOf(params.terminal)
        // Why this Mac's own: a Claude account selection is per runtime, and PodNative's panes are
        // this host's (an SSH or WSL pane answers false, as the classic banner hides there too).
        const openedBefore = ptyId !== null && onLegacyDaemon(ptyId) && runsAnother() === true
        return { openedBefore }
      }
    })
  ]
}

export const POD_CLAUDE_OLD_TERMINAL_METHODS = createPodClaudeOldTerminalMethods()
