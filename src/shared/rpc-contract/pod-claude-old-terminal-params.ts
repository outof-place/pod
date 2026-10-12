import { z } from 'zod'

// Pod: a runtime terminal handle (pod.terminal.openedBeforeClaudeAccounts).
export const PodTerminalOpenedBeforeClaudeAccountsParams = z
  .object({ terminal: z.string().min(1) })
  .strict()
