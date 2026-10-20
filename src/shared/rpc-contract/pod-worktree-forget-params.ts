// Fork-only (Pod): params of worktree.forgetLocal, the desktop's worktrees:forgetLocal over RPC.
import { z } from 'zod'

/** One workspace on one host, both named exactly: the RPC never guesses an owner. */
export const WorktreeForgetLocalParams = z
  .object({
    /** `repoId::path`, as worktree.list gives it. */
    worktreeId: z.string().min(1).max(4096),
    /** The workspace's host, `ssh:<target>`; it must be the one Pod has for this workspace. */
    hostId: z.string().min(1).max(1024)
  })
  .strict()
