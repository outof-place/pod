import { z } from 'zod'

const WorktreeId = z.string().min(1).max(8_192)

export const PodOrbstackCreateParams = z
  .object({ worktreeId: WorktreeId, displayName: z.string().max(512).optional() })
  .strict()

export const PodOrbstackWorktreeParams = z.object({ worktreeId: WorktreeId }).strict()

export const PodOrbstackMachineParams = z.object({ name: z.string().min(1).max(63) }).strict()

export const PodOrbstackDockerPinParams = z
  .object({ worktreeId: WorktreeId, pinned: z.boolean() })
  .strict()
