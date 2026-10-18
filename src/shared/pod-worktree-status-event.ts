// Fork-only (Pod): the opt-in `worktreeStatusChanged` frame of runtime.clientEvents.subscribe.
import type { RuntimeWorktreePsSummary } from './runtime-types'

/**
 * A worktree's place in worktree.ps's ranking moved (its status or working mode), or, for a
 * subscription that passed `worktreeStatus.agents`, what one of its agent rows shows. `snapshotId`
 * is the one worktree.ps returns for the subscription's read params, so a client already holding
 * it skips the read. Only sent to a subscription that passed `worktreeStatus`.
 */
export type PodWorktreeStatusChangedEvent = {
  type: 'worktreeStatusChanged'
  worktreeId: string
  snapshotId: string
  status: RuntimeWorktreePsSummary['status']
  workingMode?: RuntimeWorktreePsSummary['workingMode']
  /**
   * For `worktreeStatus.rows`: this worktree's row exactly as worktree.ps returned it at
   * `snapshotId`, so a client can draw it without waiting for a read; keep reading worktree.ps
   * when `snapshotId` differs from the client's own. Absent from runtimes before it.
   */
  worktree?: RuntimeWorktreePsSummary
}

/** Added to the subscription's `ready` frame when the runtime honours the opt-in; the second
 *  when it honours `agents` too. */
export type PodWorktreeStatusReadyFields = { worktreeStatus?: true; worktreeStatusAgents?: true }
