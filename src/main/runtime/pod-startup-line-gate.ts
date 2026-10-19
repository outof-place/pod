// Fork-only (Pod): the PTY host refuses a startup line only staging delivers whole when it cannot
// stage it (`stageStartupCommand`'s `refuseUnstaged`). This takes that decision before a tab or PTY
// exists, so the create fails with `agent_prompt_needs_paste` and the client pastes instead.
import type { Repo } from '../../shared/repo-types'
import {
  AgentPromptNeedsPasteError,
  type AgentPromptNeedsPasteReason
} from '../../shared/pod-agent-prompt-needs-paste'
import { startupLineRefusal, startupLineStagingReason } from '../../shared/startup-command-staging'
import { getActiveMultiplexer } from '../ssh/ssh-target-registry'
import { resolveWorktreeCreateRoute } from '../worktree-create-execution-host-route'
import { nameLocalTypedLineShell } from './agent-launch-typed-line-shell'

/** The relay request that answers for its own shell and tmp dir (relay/pty-handler.ts). */
export const RELAY_STARTUP_LINE_REFUSAL_METHOD = 'pty.startupLineRefusal'

const REFUSAL_REASONS: readonly AgentPromptNeedsPasteReason[] = [
  'control-byte',
  'multi-line',
  'line-too-long'
]

export async function assertStartupLineTypeable(args: {
  command: string | undefined
  launchAgent: string | undefined
  /** Set for an SSH workspace, whose relay types the line. */
  connectionId?: string | null
  shellOverride?: string
  defaultShellSetting?: string
  /** The spawn env's SHELL, which a relay prefers over its own default shell. */
  envShell?: string
}): Promise<void> {
  if (!args.command) {
    return
  }
  if (args.connectionId) {
    await assertRelayStartupLineTypeable(args.connectionId, args.command, args)
    return
  }
  // Undefined on Windows, which has no staging.
  const shellName = nameLocalTypedLineShell({
    isRemote: false,
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

async function assertRelayStartupLineTypeable(
  connectionId: string,
  command: string,
  args: { launchAgent: string | undefined; envShell?: string }
): Promise<void> {
  // Why first: a line that needs no staging is typed as is everywhere, without a round trip.
  const reason = startupLineStagingReason(command)
  if (reason === null) {
    return
  }
  let mux: ReturnType<typeof getActiveMultiplexer>
  try {
    mux = getActiveMultiplexer(connectionId)
  } catch {
    mux = undefined
  }
  // Plain SSH mode has no relay to stage the line, and a host that is not connected cannot answer.
  if (!mux) {
    throw new AgentPromptNeedsPasteError(reason)
  }
  let answer: unknown
  try {
    answer = await mux.request(RELAY_STARTUP_LINE_REFUSAL_METHOD, {
      command,
      ...(args.launchAgent ? { launchAgent: args.launchAgent } : {}),
      ...(args.envShell ? { env: { SHELL: args.envShell } } : {})
    })
  } catch {
    // A relay from before this check answers -32601; it may not stage at all, so fail closed.
    throw new AgentPromptNeedsPasteError(reason)
  }
  const refusal = readRelayRefusal(answer)
  if (refusal === undefined) {
    throw new AgentPromptNeedsPasteError(reason)
  }
  if (refusal !== null) {
    throw new AgentPromptNeedsPasteError(refusal)
  }
}

/** The relay's verdict, or undefined for an answer this client cannot read. */
function readRelayRefusal(answer: unknown): AgentPromptNeedsPasteReason | null | undefined {
  if (typeof answer !== 'object' || answer === null || !('reason' in answer)) {
    return undefined
  }
  if (answer.reason === null) {
    return null
  }
  return REFUSAL_REASONS.find((reason) => reason === answer.reason)
}

/** worktree.create's check, before the worktree exists: the line its startup terminal types. */
export async function gateWorktreeStartupLine(
  startup: { command?: string; env?: Record<string, string> } | undefined,
  createdWithAgent: string | undefined,
  repo: Repo,
  settings: { terminalDefaultShell?: string }
): Promise<void> {
  const route = resolveWorktreeCreateRoute(repo)
  if (route.kind === 'runtime') {
    // Created by that environment's own server.
    return
  }
  await assertStartupLineTypeable({
    command: startup?.command,
    launchAgent: createdWithAgent,
    connectionId: route.kind === 'ssh' ? route.connectionId : null,
    defaultShellSetting: settings.terminalDefaultShell,
    envShell: startup?.env?.SHELL
  })
}
