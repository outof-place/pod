// Fork-only (Pod): podSettings fields about launching agents and what they draft for git.
import { z } from 'zod'
import { AI_TEXT_ACTION_IDS } from './source-control-ai-actions'
import { row } from './pod-settings-row'
import { TuiAgentSchema } from './pod-settings-tui-agent-schema'

// History only: which account, config and hooks Codex uses stays as it is. WSL paths are Windows'.
const CodexSessionSourceHomeSchema = z
  .object({
    host: row(z.string().max(4096), 'Folder', 'Empty reads ~/.codex.')
  })
  .partial()
  .strict()

// A partial write merges into the stored settings; actions and per-host models stay as they are.
const SourceControlAiSchema = z
  .object({
    enabled: row(z.boolean(), 'AI actions'),
    agentId: row(z.union([TuiAgentSchema, z.literal('custom')]).nullable(), 'Agent'),
    customAgentCommand: row(z.string().max(4096), 'Custom agent command'),
    selectedModelByAgent: row(
      z.partialRecord(TuiAgentSchema, z.string().max(256)),
      'Model per agent'
    ),
    selectedThinkingByModel: row(
      z.record(z.string().max(256), z.string().max(64)),
      'Thinking per model'
    ),
    instructionsByOperation: row(
      z.partialRecord(z.enum(AI_TEXT_ACTION_IDS), z.string().max(65_536)),
      'Instructions'
    )
  })
  .partial()
  .strict()

// Each agent's launch environment is a secret to podSettings: settings.get and settings.update carry it.
export const POD_SETTINGS_AGENT_FIELDS = {
  agentCmdOverrides: row(
    z.partialRecord(TuiAgentSchema, z.string().max(4096)),
    'Commands',
    "Per agent, the command Pod runs instead of the agent's own. Written whole: a missing agent uses its default."
  ),
  agentDefaultArgs: row(
    z.partialRecord(TuiAgentSchema, z.string().max(4096)),
    'Arguments',
    'Per agent, appended to every launch before the prompt. Written whole.'
  ),
  promptCacheTimerEnabled: row(
    z.boolean(),
    'Prompt cache timer',
    "Counts down Claude's prompt cache after an agent goes idle."
  ),
  promptCacheTtlMs: row(
    z.union([z.literal(300_000), z.literal(3_600_000)]),
    'Prompt cache lifetime',
    '5 minutes, or an hour on plans with the extended cache.'
  ),
  // The runtime's dispatch fence reads it (resolveNestedWorkerMaxDepth); podSettings is host-admin,
  // so an agent's own paired client can't raise it.
  nestedWorkerMaxDepth: row(
    z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    'Nested worker depth',
    'How many generations of dispatched workers may spawn their own workers. 1 keeps the agent tree flat: a coordinator dispatches workers, and those workers do not dispatch.'
  ),
  // Session tab snapshots carry the generated title only while this is on.
  tabAutoGenerateTitle: row(
    z.boolean(),
    'Auto-generate tab titles',
    'Derive short stable tab names from the first known agent prompt. Manual renames always win.'
  ),
  codexSessionSourceHome: CodexSessionSourceHomeSchema.meta({
    title: 'Codex history folder',
    propertyOrder: Object.keys(CodexSessionSourceHomeSchema.shape)
  }),
  sourceControlAi: SourceControlAiSchema.meta({
    title: 'AI for commit messages and pull requests',
    description: 'Drafts commit messages, pull request details and branch names with an agent.',
    propertyOrder: Object.keys(SourceControlAiSchema.shape)
  })
}
