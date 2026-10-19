// Fork-only (Pod): linear.setEnabled, linear.setAgentAccess and linear.getIssues.
import { z } from 'zod'

export const PodLinearSetEnabledParams = z.object({ enabled: z.boolean() }).strict()

export const PodLinearSetAgentAccessParams = z.object({ enabled: z.boolean() }).strict()

// Why 50: one card list's worth; the runtime asks Linear for exactly these ids in one request.
export const PodLinearGetIssuesParams = z
  .object({
    ids: z.array(z.string().trim().min(1).max(128)).min(1).max(50),
    workspaceId: z.string().trim().min(1).max(256).optional()
  })
  .strict()
