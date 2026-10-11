import { z } from 'zod'

const WorktreeId = z.string().min(1).max(8_192)
const MachineKind = z.enum(['shared', 'sandbox'])

export const PodOrbstackCreateParams = z
  .object({
    worktreeId: WorktreeId,
    displayName: z.string().max(512).optional(),
    kind: MachineKind.optional()
  })
  .strict()

export const PodOrbstackWorktreeParams = z
  .object({ worktreeId: WorktreeId, kind: MachineKind.optional() })
  .strict()

export const PodOrbstackMachineParams = z.object({ name: z.string().min(1).max(63) }).strict()

export const PodOrbstackDockerPinParams = z
  .object({ worktreeId: WorktreeId, pinned: z.boolean() })
  .strict()

export const PodOrbstackAgentSandboxParams = z
  .object({ worktreeId: WorktreeId, enabled: z.boolean() })
  .strict()

export const PodOrbstackSandboxClaudeLoginParams = z.object({ enabled: z.boolean() }).strict()

/** Absent or null params read everything; `containers: false` skips docker ps/stats. */
export const PodOrbstackStatusParams = z.object({ containers: z.boolean().optional() }).strict()

/** Filters a stats tick to these machines; absent means every running Pod machine. */
export const PodOrbstackStatsParams = z
  .object({ names: z.array(z.string().min(1).max(63)).max(256).optional() })
  .strict()

export const PodOrbstackUnsubscribeParams = z
  .object({ subscriptionId: z.string().min(1).max(256) })
  .strict()

export const PodOrbstackTemplatesParams = z.object({ enabled: z.boolean() }).strict()

/** A restart is the user's own act; a client that can't say so is refused. */
export const PodOrbstackRestartParams = z.object({ reason: z.literal('user') }).strict()
