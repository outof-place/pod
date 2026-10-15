import { z } from 'zod'
import { PodSettingsValuesSchema } from '../pod-settings-schema'

/** Every write is the user's own act; a client that can't say so is refused. */
const UserIntent = z.literal('user')

export const PodSettingsSetParams = z
  .object({
    values: PodSettingsValuesSchema,
    /** The revision the client's values came from; another one makes the write a conflict. */
    baseRevision: z.string().min(1).max(128),
    reason: UserIntent
  })
  .strict()

export const PodSettingsUnsubscribeParams = z
  .object({ subscriptionId: z.string().min(1).max(256) })
  .strict()

/** The proxy URL as typed: the runtime checks and trims it as Pod's network settings do; '' clears it. */
export const PodSettingsSetNetworkProxyParams = z
  .object({
    httpProxyUrl: z.string().max(4096),
    reason: UserIntent
  })
  .strict()
