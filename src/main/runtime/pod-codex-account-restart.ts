// Fork-only (Pod): terminal.create's `codexAccountRestart`, the RPC twin of the renderer's Codex
// restart after an account switch: the pane's Codex resumes in the account selected now.
import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'
import type { WorktreeStartupLaunch } from '../../shared/worktree/launch-types'
import type { TuiAgent } from '../../shared/tui-agent'
import type { PaneAgentResumeStartup } from './orca-runtime-headless-agent-resume'

export type PodCodexAccountRestartLaunch = {
  codexAccountRestart?: true
  command?: string
  env?: Record<string, string>
  launchConfig?: WorktreeStartupLaunch['launchConfig']
  startupCommandDelivery?: WorktreeStartupLaunch['startupCommandDelivery']
  resumeProviderSession?: AgentProviderSessionMetadata
  launchAgent?: TuiAgent
}

/** The pane's own Codex resume when the runtime knows its session, else the caller's launch. */
export async function podCodexAccountRestartLaunch(
  runtime: {
    resolvePodPaneAgentRestart(
      worktreeSelector: string,
      tabId: string,
      leafId: string
    ): Promise<PaneAgentResumeStartup | null>
  },
  params: {
    codexAccountRestart?: true
    worktree?: string
    tabId?: string
    leafId?: string
  }
): Promise<PodCodexAccountRestartLaunch> {
  if (!params.codexAccountRestart) {
    return {}
  }
  const startup =
    params.worktree && params.tabId && params.leafId
      ? await runtime
          .resolvePodPaneAgentRestart(params.worktree, params.tabId, params.leafId)
          .catch(() => null)
      : null
  if (startup?.agent !== 'codex') {
    return { codexAccountRestart: true }
  }
  return {
    codexAccountRestart: true,
    command: startup.command,
    launchAgent: 'codex',
    resumeProviderSession: startup.providerSession,
    ...(startup.env ? { env: startup.env } : {}),
    ...(startup.launchConfig ? { launchConfig: startup.launchConfig } : {}),
    ...(startup.startupCommandDelivery
      ? { startupCommandDelivery: startup.startupCommandDelivery }
      : {})
  }
}

/** The spawn's resume fields; the flag makes the resume repin to the selected account. */
export function podResumeSpawnOpts(opts: {
  resumeProviderSession?: AgentProviderSessionMetadata
  codexAccountRestart?: true
}): {
  resumeProviderSession?: AgentProviderSessionMetadata
  codexAccountRestart?: true
} {
  return {
    resumeProviderSession: opts.resumeProviderSession,
    ...(opts.codexAccountRestart ? { codexAccountRestart: true } : {})
  }
}
