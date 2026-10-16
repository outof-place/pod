// Fork-only (Pod): answers to SSH connect prompts over RPC, the desktop's ssh:submitCredential.
import { z } from 'zod'

export const SshSubmitCredentialParams = z
  .object({
    requestId: z.string().min(1).max(128),
    /** null cancels the prompt, as the dialog's Cancel does. */
    value: z.string().max(65_536).nullable()
  })
  .strict()

export const SshCredentialPromptsUnsubscribeParams = z
  .object({ subscriptionId: z.string().min(1).max(256) })
  .strict()
