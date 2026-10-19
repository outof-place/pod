// Fork-only (Pod): linear.setAgentAccess.
import { z } from 'zod'

export const PodLinearSetAgentAccessParams = z.object({ enabled: z.boolean() }).strict()
