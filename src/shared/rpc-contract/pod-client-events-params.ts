import { z } from 'zod'
import { WorktreePsParams } from './worktree-params'

// Fork-only (Pod): upstream's subscribe takes no params, so a malformed field or body is dropped,
// never refused: every caller that subscribed before still does.
export const PodClientEventsSubscribeParams = z
  .object({
    /** Opt in to `worktreeStatusChanged`, for these worktree.ps read params (`true`: defaults). */
    worktreeStatus: z
      .union([z.literal(true), WorktreePsParams.omit({ afterSnapshotId: true })])
      .optional()
      .catch(undefined)
  })
  .catch({})
