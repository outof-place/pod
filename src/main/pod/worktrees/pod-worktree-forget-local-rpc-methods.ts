// Fork-only (Pod): the desktop's worktrees:forgetLocal over RPC, for PodNative's banner on a
// workspace whose SSH host was removed or is disconnected.
import { defineMethod } from '../../runtime/rpc/core'
import { assertLocalRpcCaller } from '../../runtime/rpc/methods/pod-local-caller'
import { WorktreeForgetLocalParams } from '../../../shared/rpc-contract/pod-worktree-forget-params'
import { getPodWorktreeForgetLocal } from './pod-worktree-forget-local-rpc'

// Why host-admin: it purges a workspace from Pod, and an SSH host's CLI with remote control on holds
// `workspace`; the local-caller check refuses any paired device as well. PodNative calls as local-cli
// (its owner token on the runtime socket), and so does an agent's orca CLI in a Pod terminal: the two
// can't be told apart. What bounds an agent is the forget itself: an SSH host only, the host Pod has
// for the workspace, refused while that host's provider is connected, and nothing on the host.
export const POD_WORKTREE_FORGET_LOCAL_METHODS = [
  defineMethod({
    name: 'worktree.forgetLocal',
    permission: 'host-admin',
    params: WorktreeForgetLocalParams,
    handler: async (params, ctx) => {
      assertLocalRpcCaller(ctx, 'worktree.forgetLocal')
      const forget = getPodWorktreeForgetLocal()
      if (!forget) {
        throw new Error('runtime_unavailable')
      }
      await forget(params)
      return { forgotten: true as const }
    }
  })
]
