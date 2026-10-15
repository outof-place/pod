// Fork-only (Pod): AI vault calls the desktop made over IPC only.
import { z } from 'zod'
import { AI_VAULT_AGENTS } from '../ai-vault-types'
import { AI_VAULT_SCOPE_PATH_MAX_LENGTH } from './ai-vault-params'

/** `aiVault:deleteSession`'s payload: the row's agent, log path and host, as the list gave them. */
export const AiVaultDeleteSessionParams = z
  .object({
    agent: z.enum(AI_VAULT_AGENTS),
    filePath: z.string().min(1).max(AI_VAULT_SCOPE_PATH_MAX_LENGTH),
    sessionId: z.string().min(1).max(512).optional(),
    /** The row's host; absent means this machine. Only this machine's logs are deleted. */
    executionHostId: z.string().min(1).max(1024).optional()
  })
  .strict()
