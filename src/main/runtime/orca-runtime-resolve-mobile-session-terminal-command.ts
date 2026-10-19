// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithRunCreateMobileSessionTerminal } from './orca-runtime-run-create-mobile-session-terminal'
import type { TerminalWorkspaceLaunchScope } from './runtime-legacy-worker-terminal-recovery-types'
import type { WorktreeStartupLaunch } from '../../shared/worktree/launch-types'
import type { TuiAgent } from '../../shared/tui-agent'
import type { SleepingAgentLaunchConfig } from '../../shared/agent-session-resume'
import { isTuiAgentEnabled } from '../../shared/tui-agent-selection'
import { resolveAgentStartupPlanInputs } from '../../shared/agent-startup-plan-inputs'
import { planStartupWithPromptCandidate } from '../../shared/startup-line-prompt-carry'
import { AgentPromptNeedsPasteError } from '../../shared/agent-prompt-needs-paste'
import { agentPromptRidesLaunchCommand } from '../../shared/tui-agent-startup'
import {
  launchHostProvesAgentInFront,
  nameLocalTypedLineShell
} from './agent-launch-typed-line-shell'
import { withPodSandboxLaunchChoice } from '../pod/orbstack/pod-orbstack-terminal-override'
import { withRequestedAgentArgs } from '../../shared/pod-create-terminal-agent-args'

export class OrcaRuntimeWithResolveMobileSessionTerminalCommand extends OrcaRuntimeWithRunCreateMobileSessionTerminal {
  protected async resolveMobileSessionTerminalCommand(
    workspace: TerminalWorkspaceLaunchScope,
    opts: {
      command?: string
      env?: Record<string, string>
      envToDelete?: string[]
      startupCommandDelivery?: WorktreeStartupLaunch['startupCommandDelivery']
      agent?: TuiAgent
      agentPrompt?: string
      agentArgs?: readonly string[]
      launchConfig?: SleepingAgentLaunchConfig
      launchAgent?: TuiAgent
    }
  ): Promise<{
    command?: string
    env?: Record<string, string>
    envToDelete?: string[]
    startupCommandDelivery?: WorktreeStartupLaunch['startupCommandDelivery']
    launchConfig?: SleepingAgentLaunchConfig
    launchAgent?: TuiAgent
  }> {
    if (opts.command || !opts.agent) {
      return {
        command: opts.command,
        env: opts.env,
        envToDelete: opts.envToDelete,
        launchConfig: opts.launchConfig,
        launchAgent: opts.launchAgent,
        startupCommandDelivery: opts.startupCommandDelivery
      }
    }
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    const settings = this.store.getSettings()
    if (!isTuiAgentEnabled(opts.agent, settings.disabledTuiAgents)) {
      throw new Error('Selected agent is disabled. Choose an enabled agent before creating.')
    }
    const launchPlatform = this.getAgentLaunchPlatformForWorkspace(workspace)
    const isRemote = Boolean(workspace.connectionId)
    const prompt = opts.agentPrompt ?? ''
    // Fork-only (Pod): the prompt rides the typed line only where planStartupWithPromptCandidate
    // finds it can; this path has no paste after start, so text it can't carry is refused whole.
    const offered = planStartupWithPromptCandidate(
      // Fork-only (Pod): the request's agentArgs replace the configured ones; no-op without them.
      withRequestedAgentArgs(
        resolveAgentStartupPlanInputs({
          agent: opts.agent,
          settings,
          // Why: mobile may be iOS while the shell host is Windows/macOS/Linux or SSH Linux; quote for the host shell.
          platform: launchPlatform,
          // Why: SSH runs the CLI through the relay shim (plain `orca`), so the Linux-only `orca-ide` rename must not apply.
          isRemote
        }),
        opts.agentArgs
      ),
      prompt,
      {
        shellName: nameLocalTypedLineShell({
          isRemote,
          ...(settings.terminalDefaultShell
            ? { defaultShellSetting: settings.terminalDefaultShell }
            : {})
        }),
        provesAgentInFront: launchHostProvesAgentInFront({ isRemote, launchPlatform })
      }
    )
    const startupPlan = offered.plan
    if (!startupPlan) {
      throw new Error(`Could not build launch command for ${opts.agent}.`)
    }
    if (prompt.trim() && !offered.promptCarried) {
      // A stdin-after-start agent keeps its old answer; anything else wasn't safe to type.
      if (!agentPromptRidesLaunchCommand(opts.agent)) {
        throw new Error(`Agent ${opts.agent} does not support startup prompt quick commands.`)
      }
      // Within the gate but past a whole-line check (zsh's multi-line total): still too long.
      throw new AgentPromptNeedsPasteError(offered.refusal ?? 'line-too-long')
    }
    return {
      command: startupPlan.launchCommand,
      // Fork-only (Pod): the caller's OrbStack sandbox choice; no-op without the marker.
      env: withPodSandboxLaunchChoice(startupPlan.env, opts.env),
      // Why: a real-home Codex resume strips inherited CODEX_HOME via
      // envToDelete; dropping it here would resume against the wrong home.
      envToDelete: opts.envToDelete,
      launchConfig: startupPlan.launchConfig,
      launchAgent: opts.agent,
      startupCommandDelivery: startupPlan.startupCommandDelivery
    }
  }
}
