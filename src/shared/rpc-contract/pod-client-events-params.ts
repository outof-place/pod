import { z } from 'zod'
import { WorktreePsParams } from './worktree-params'

// Fork-only (Pod): upstream's subscribe takes no params, so a malformed field or body is dropped,
// never refused: every caller that subscribed before still does.
export const PodClientEventsSubscribeParams = z
  .object({
    /** Opt in to `worktreeStatusChanged`, for these worktree.ps read params (`true`: defaults).
     *  `agents: true` also sends it when a worktree's agent rows change what they show. */
    worktreeStatus: z
      .union([
        z.literal(true),
        WorktreePsParams.omit({ afterSnapshotId: true }).extend({
          agents: z.literal(true).optional().catch(undefined)
        })
      ])
      .optional()
      .catch(undefined),
    /** Opt in to `keybindingsChanged`: keybindings.effective's answer each time the file changes it. */
    keybindings: z.literal(true).optional().catch(undefined)
  })
  .catch({})
