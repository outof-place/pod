import { z } from 'zod'

const Id = z.string().min(1).max(8_192)

export const PodWorkspaceStatusParams = z.object({ refresh: z.boolean().optional() }).strict()

export const PodWorkspaceTidyScanParams = z
  .object({ repoIds: z.array(Id).max(500).optional() })
  .strict()

export const PodWorkspaceTidyApplyParams = z
  .object({
    action: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('archive'), worktreeId: Id }).strict(),
      z.object({ kind: z.literal('restore'), archiveId: Id }).strict(),
      z.object({ kind: z.literal('forget'), archiveId: Id }).strict(),
      z.object({ kind: z.literal('prune'), repoId: Id }).strict(),
      z.object({ kind: z.literal('trash-stray'), repoId: Id, path: Id }).strict(),
      z.object({ kind: z.literal('stop-watcher'), worktreeId: Id }).strict()
    ])
  })
  .strict()

export const PodWorkspaceGitProfileParams = z
  .object({ repoId: Id, action: z.enum(['plan', 'apply', 'revert']) })
  .strict()

export const PodWorkspaceCloneDestinationParams = z.object({ url: z.string().max(8_192) }).strict()

export const PodWorkspaceAdoptParams = z
  .object({
    action: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('plan'), repoId: Id }).strict(),
      z.object({ kind: z.literal('apply'), repoId: Id }).strict(),
      z.object({ kind: z.literal('undo'), recordId: Id }).strict()
    ])
  })
  .strict()
