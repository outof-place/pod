import { z } from 'zod'

const ProfileId = z.string().min(1).max(256)
const PreviewId = z.string().min(1).max(128)
const ItemId = z.string().min(1).max(8_192)
/** Every apply is the user's own act; a client that can't say so is refused. */
const UserIntent = z.literal('user')

export const PodOrcaImportPreviewParams = z
  .object({
    /** One of Orca's profiles; its active one when omitted. */
    profileId: ProfileId.optional()
  })
  .strict()

export const PodOrcaImportApplyParams = z
  .object({
    previewId: PreviewId,
    itemIds: z.array(ItemId).max(5_000),
    reason: UserIntent
  })
  .strict()
