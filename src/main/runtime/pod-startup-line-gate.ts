// Fork-only (Pod): the PTY host refuses a startup line only staging delivers whole when it cannot
// stage it (`stageStartupCommand`'s `refuseUnstaged`). This takes that decision before a tab or PTY
// exists, so the create fails with `agent_prompt_needs_paste` and the client pastes instead.
import type { Repo } from '../../shared/repo-types'
import { AgentPromptNeedsPasteError } from '../../shared/pod-agent-prompt-needs-paste'
import { startupLineRefusal } from '../../shared/startup-command-staging'
import { resolveWorktreeCreateRoute } from '../worktree-create-execution-host-route'
import { nameLocalTypedLineShell } from './agent-launch-typed-line-shell'

export function assertLocalStartupLineTypeable(args: {
  command: string | undefined
  launchAgent: string | undefined
  isRemote: boolean
  shellOverride?: string
  defaultShellSetting?: string
}): void {
  if (!args.command) {
    return
  }
  // Undefined for a remote host, whose relay types its own line, and for Windows.
  const shellName = nameLocalTypedLineShell({
    isRemote: args.isRemote,
    ...(args.shellOverride ? { shellOverride: args.shellOverride } : {}),
    ...(args.defaultShellSetting ? { defaultShellSetting: args.defaultShellSetting } : {})
  })
  if (shellName === undefined) {
    return
  }
  const reason = startupLineRefusal({
    command: args.command,
    shellPath: shellName,
    orcaBuiltLine: args.launchAgent !== undefined
  })
  if (reason) {
    throw new AgentPromptNeedsPasteError(reason)
  }
}

/** worktree.create's check, before the worktree exists: the line its startup terminal types. */
export function assertWorktreeLineTypeable(
  startup: { command?: string } | undefined,
  createdWithAgent: string | undefined,
  repo: Repo,
  settings: { terminalDefaultShell?: string }
): void {
  assertLocalStartupLineTypeable({
    command: startup?.command,
    launchAgent: createdWithAgent,
    isRemote: resolveWorktreeCreateRoute(repo).kind !== 'local',
    defaultShellSetting: settings.terminalDefaultShell
  })
}
