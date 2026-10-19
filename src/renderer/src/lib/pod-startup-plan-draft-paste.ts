// Fork-only (Pod): a prompt the typed launch line refuses (`agent_prompt_needs_paste`) is not
// typed: the agent starts clean and the prompt is pasted as a draft once it is ready.
import { buildAgentStartupPlan, type AgentStartupPlan } from '@/lib/tui-agent-startup'
import { startupPromptNeedsPaste } from '../../../shared/startup-line-prompt-carry'

export function buildAgentStartupPlanOrDraftPaste(
  args: Parameters<typeof buildAgentStartupPlan>[0]
): AgentStartupPlan | null {
  if (!args.prompt.trim() || !startupPromptNeedsPaste(args, args.prompt)) {
    return buildAgentStartupPlan(args)
  }
  const plan = buildAgentStartupPlan({ ...args, prompt: '', allowEmptyPromptLaunch: true })
  if (plan) {
    plan.draftPrompt = args.prompt.trim()
  }
  return plan
}
