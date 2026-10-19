// Fork-only (Pod): linear.setEnabled and linear.setAgentAccess.
import { z } from 'zod'

export const PodLinearSetEnabledParams = z.object({ enabled: z.boolean() }).strict()

export const PodLinearSetAgentAccessParams = z.object({ enabled: z.boolean() }).strict()
