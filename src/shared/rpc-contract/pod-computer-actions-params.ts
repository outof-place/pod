// Fork-only (Pod): params of the computer.actions stream.
import { z } from 'zod'

export const PodComputerActionsUnsubscribeParams = z
  .object({ subscriptionId: z.string().min(1).max(256) })
  .strict()
