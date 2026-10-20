// Fork-only (Pod): worktree.forgetLocal's refusal, the RPC twin of the desktop's worktrees:forgetLocal.

/** The forget refused before changing anything; `data.reason` says why. */
export const POD_WORKTREE_FORGET_REFUSED_CODE = 'worktree_forget_refused' as const

export type PodWorktreeForgetRefusalReason =
  /** Only an SSH workspace is forgotten over RPC; a local one would leave its files unlisted. */
  | 'unsupported_host'
  /** The host's provider is connected, so the forget would reach the host's live sessions. */
  | 'host_connected'
  /** The host the caller named is not the one Pod has for this workspace. */
  | 'host_mismatch'
  /** Two hosts register this workspace's project, so no single partition can be named. */
  | 'ambiguous_host'
  /** Pod has neither this workspace nor its project on that host. */
  | 'unknown_worktree'
