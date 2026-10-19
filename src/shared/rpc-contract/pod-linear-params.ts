// Fork-only (Pod): linear.setEnabled, linear.setAgentAccess and linear.getIssues.
import { z } from 'zod'

export const PodLinearSetEnabledParams = z.object({ enabled: z.boolean() }).strict()

export const PodLinearSetAgentAccessParams = z.object({ enabled: z.boolean() }).strict()

// Linear issue UUIDs (LinearIssue.id) or identifiers like ENG-9, mixed freely. Why 50: one card
// list's worth; the runtime asks Linear for exactly these in one request per workspace.
// Identifiers resolve in the selected workspace. Under "all", the first workspace (by organization
// name) that has one wins, so pass workspaceId when two may share a team key. An issue moved to
// another team since is asked for by its old identifier and comes back in `missing`.
export const PodLinearGetIssuesParams = z
  .object({
    ids: z.array(z.string().trim().min(1).max(128)).min(1).max(50),
    workspaceId: z.string().trim().min(1).max(256).optional()
  })
  .strict()
