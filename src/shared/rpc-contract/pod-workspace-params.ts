import { z } from 'zod'

const Id = z.string().min(1).max(8_192)
const PlanId = z.string().min(1).max(128)
/** Every apply is the user's own act; a client that can't say so is refused. */
const UserIntent = z.literal('user')
const SoftBlocker = z.enum(['dirty', 'unpushed', 'process-inside'])

export const PodWorkspaceStatusParams = z.object({ refresh: z.boolean().optional() }).strict()

export const PodWorkspaceValidateRootParams = z.object({ value: z.string().max(8_192) }).strict()

export const PodWorkspaceExcludeBuildFoldersParams = z
  .object({ planId: PlanId, reason: UserIntent })
  .strict()

export const PodWorkspaceUserIntentParams = z.object({ reason: UserIntent }).strict()

export const PodWorkspaceTidyScanParams = z
  .object({ repoIds: z.array(Id).max(500).optional() })
  .strict()

export const PodWorkspaceTidyApplyParams = z
  .object({
    planId: PlanId,
    reason: UserIntent,
    /** Soft blockers the plan listed for this target and the user ticked. */
    acknowledged: z.array(SoftBlocker).max(3).optional(),
    action: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('archive'), worktreeId: Id }).strict(),
      z.object({ kind: z.literal('restore'), archiveId: Id }).strict(),
      z.object({ kind: z.literal('forget'), archiveId: Id }).strict(),
      z.object({ kind: z.literal('prune'), repoId: Id }).strict(),
      z.object({ kind: z.literal('trash-stray'), repoId: Id, path: Id }).strict(),
      z.object({ kind: z.literal('put-back'), trashedId: Id }).strict(),
      z.object({ kind: z.literal('stop-watcher'), worktreeId: Id }).strict()
    ])
  })
  .strict()

const OptIn = z.enum(['reftable', 'many-files', 'bitmaps', 'backfill'])

export const PodWorkspaceGitProfileParams = z.discriminatedUnion('action', [
  z.object({ action: z.literal('plan'), repoId: Id }).strict(),
  z
    .object({
      action: z.literal('apply'),
      planId: PlanId,
      reason: UserIntent,
      optIns: z.array(OptIn).max(4).optional()
    })
    .strict(),
  z.object({ action: z.literal('undo'), planId: PlanId, reason: UserIntent, tuneId: Id }).strict()
])

export const PodWorkspaceCloneDestinationParams = z.object({ url: z.string().max(8_192) }).strict()

export const PodWorkspaceAdoptParams = z.discriminatedUnion('action', [
  z.object({ action: z.literal('plan'), repoId: Id }).strict(),
  z
    .object({
      action: z.literal('apply'),
      planId: PlanId,
      reason: UserIntent,
      acknowledged: z.array(z.literal('process-inside')).max(1).optional()
    })
    .strict(),
  z.object({ action: z.literal('plan-undo'), recordId: Id }).strict(),
  z.object({ action: z.literal('undo'), planId: PlanId, reason: UserIntent }).strict()
])
