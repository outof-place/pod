// Fork-only (Pod): the opt-in `worktreeStatusChanged` frame of runtime.clientEvents.subscribe.
import type { RuntimeWorktreePsSummary } from './runtime-types'

/**
 * A worktree's place in worktree.ps's ranking moved (its status or working mode). `snapshotId` is
 * the one worktree.ps returns for the subscription's read params, so a client already holding it
 * skips the read. Only sent to a subscription that passed `worktreeStatus`.
 */
export type PodWorktreeStatusChangedEvent = {
  type: 'worktreeStatusChanged'
  worktreeId: string
  snapshotId: string
  status: RuntimeWorktreePsSummary['status']
  workingMode?: RuntimeWorktreePsSummary['workingMode']
}

/** Added to the subscription's `ready` frame when the runtime honours the opt-in. */
export type PodWorktreeStatusReadyFields = { worktreeStatus?: true }
