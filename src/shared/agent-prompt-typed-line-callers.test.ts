// Fork-only (Pod): every call that can put prompt text on a typed launch line, and how it treats a
// prompt the line refuses (`agent_prompt_needs_paste`). A new call fails here until it is listed.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(__dirname, '..')

const BUILDERS = [
  'buildAgentStartupPlan',
  'buildAgentDraftLaunchPlan',
  'buildFlagPromptStartupPlan',
  'planStartupWithPromptCandidate',
  'startupPromptNeedsPaste',
  'buildAgentStartupPlanOrDraftPaste',
  'buildExecutionHostAgentStartupPlan',
  'planExecutionHostStartupWithPromptCandidate'
] as const

type Builder = (typeof BUILDERS)[number]

// `file → builder → [calls, what a refused prompt does there]`.
const INVENTORY: Record<string, Partial<Record<Builder, [number, string]>>> = {
  'shared/tui-agent-startup.ts': {
    buildFlagPromptStartupPlan: [1, 'inside the gate (typed)']
  },
  'shared/startup-line-prompt-carry.ts': {
    buildAgentStartupPlan: [3, 'planner: proving host starts clean, else rethrows; probe; clean']
  },
  'main/opencode/opencode-model-startup-plan.ts': {
    buildAgentDraftLaunchPlan: [1, 'terminal.createAgentSession draft: throws'],
    buildAgentStartupPlan: [1, 'terminal.createAgentSession auto-submit: throws'],
    planStartupWithPromptCandidate: [1, 'planner']
  },
  'main/runtime/orca-runtime-create-agent-session.ts': {
    buildExecutionHostAgentStartupPlan: [1, 'throws to the RPC caller']
  },
  'main/runtime/orca-runtime-resolve-mobile-session-terminal-command.ts': {
    planStartupWithPromptCandidate: [1, 'session.tabs.createTerminal: throws, nothing spawned']
  },
  'main/runtime/runtime-agent-terminal-startup.ts': {
    planExecutionHostStartupWithPromptCandidate: [1, 'terminal.create: host pastes, else throws']
  },
  'main/runtime/runtime-worktree-agent-startup.ts': {
    buildAgentDraftLaunchPlan: [1, 'worktree.create startupDraft: null, host pastes the draft'],
    buildAgentStartupPlan: [2, "prompt ''; worktree.create startupPrompt: throws"],
    planStartupWithPromptCandidate: [1, 'agent.launch: host pastes, else throws']
  },
  'renderer/src/components/sidebar/folder-workspace-agent-startup.ts': {
    buildAgentDraftLaunchPlan: [1, 'null: pasted as a draft'],
    buildAgentStartupPlan: [1, "prompt ''"]
  },
  'renderer/src/components/sidebar/folder-workspace-composer-submit.ts': {
    buildAgentStartupPlanOrDraftPaste: [1, 'pasted as a draft']
  },
  'renderer/src/hooks/composer-state/quick-startup-plan.ts': {
    buildAgentDraftLaunchPlan: [1, 'null: pasted as a draft'],
    buildAgentStartupPlanOrDraftPaste: [1, 'pasted as a draft']
  },
  'renderer/src/lib/ai-vault-antigravity-reference-startup.ts': {
    buildAgentStartupPlan: [1, "prompt ''"]
  },
  'renderer/src/lib/launch-agent-background-session.ts': {
    buildAgentStartupPlan: [1, 'refused: pasted and submitted after start'],
    startupPromptNeedsPaste: [1, 'probe']
  },
  'renderer/src/lib/launch-agent-startup-prompt-plan.ts': {
    buildAgentDraftLaunchPlan: [1, 'null: pasted after ready'],
    buildAgentStartupPlan: [2, "prompt ''; refused: pasted and submitted after ready"],
    startupPromptNeedsPaste: [1, 'probe']
  },
  'renderer/src/lib/launch-work-item-direct-agent.ts': {
    buildAgentDraftLaunchPlan: [1, 'GitHub/GitLab text, null: pasted as a draft'],
    buildAgentStartupPlan: [1, "prompt ''"]
  },
  'renderer/src/lib/onboarding-folder-agent-startup.ts': {
    buildAgentStartupPlan: [1, "prompt ''"]
  },
  'renderer/src/lib/pod-startup-plan-draft-paste.ts': {
    buildAgentStartupPlan: [2, "carried as is; prompt '' with the prompt as a draft"],
    startupPromptNeedsPaste: [1, 'probe']
  },
  'renderer/src/lib/source-control-agent-action-launch-check.ts': {
    buildAgentStartupPlan: [1, "prompt '', a launchability check"]
  }
}

function sourceFiles(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' }).filter(
    (file) =>
      /\.tsx?$/.test(file) &&
      !/\.(test|spec)\.tsx?$/.test(file) &&
      !file.endsWith('.d.ts') &&
      !file.includes('test-fixture')
  )
}

function callsIn(text: string, builder: Builder): number {
  const calls = text.match(new RegExp(`\\b${builder}\\(`, 'g'))?.length ?? 0
  const definitions = text.match(new RegExp(`function ${builder}\\(`, 'g'))?.length ?? 0
  return calls - definitions
}

describe('callers of the typed launch line builders', () => {
  it('lists every call, so a new one is classified before it can type a prompt', () => {
    const found: Record<string, Partial<Record<Builder, number>>> = {}
    for (const file of sourceFiles()) {
      const text = readFileSync(join(SRC, file), 'utf8')
      for (const builder of BUILDERS) {
        const calls = callsIn(text, builder)
        if (calls > 0) {
          const key = file.split('\\').join('/')
          found[key] = { ...found[key], [builder]: calls }
        }
      }
    }
    const listed = Object.fromEntries(
      Object.entries(INVENTORY).map(([file, builders]) => [
        file,
        Object.fromEntries(Object.entries(builders).map(([name, [calls]]) => [name, calls]))
      ])
    )
    expect(found).toEqual(listed)
  })
})
