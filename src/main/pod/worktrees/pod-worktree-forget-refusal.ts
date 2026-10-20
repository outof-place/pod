// Fork-only (Pod): worktree.forgetLocal's refusal, a structured code the RPC passes through.
import {
  POD_WORKTREE_FORGET_REFUSED_CODE,
  type PodWorktreeForgetRefusalReason
} from '../../../shared/pod-worktree-forget'

export function podWorktreeForgetRefusal(reason: PodWorktreeForgetRefusalReason): Error {
  return Object.assign(new Error(`worktree.forgetLocal refused: ${reason}`), {
    code: POD_WORKTREE_FORGET_REFUSED_CODE,
    data: { reason }
  })
}
