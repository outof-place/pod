// Fork-only (Pod): worktree.forgetLocal's forget, installed at startup: a headless runtime registers
// the desktop's worktree IPC only once a window attaches, and PodNative needs the forget without one.
import { splitWorktreeId } from '../../../shared/worktree/id'
import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { resolveWorktreeRemovalRepoOwner } from '../../worktree-removal-repo-owner'
import { InvalidArgumentError } from '../../runtime/rpc/core'
import type { Store } from '../../persistence/loading-store/store'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { forgetLocalWorktree } from './pod-worktree-forget-local'
import { getPodWorktreeRemovalRegistry } from './pod-worktree-removal-registry'
import { podWorktreeForgetRefusal } from './pod-worktree-forget-refusal'

export type PodWorktreeForgetLocalParams = { worktreeId: string; hostId: string }
export type PodWorktreeForgetLocal = (params: PodWorktreeForgetLocalParams) => Promise<void>

let installed: PodWorktreeForgetLocal | null = null

export function getPodWorktreeForgetLocal(): PodWorktreeForgetLocal | null {
  return installed
}

export function installPodWorktreeForgetLocal(store: Store, runtime: OrcaRuntimeService): void {
  installed = async (params) => {
    const hostId = resolveForgetHost(store, params)
    await forgetLocalWorktree(
      { worktreeId: params.worktreeId, hostId },
      {
        store,
        runtime,
        removalsInFlight: getPodWorktreeRemovalRegistry(),
        // Every client: the window's renderer through the runtime's notifier, and RPC clients.
        notifyChanged: (repoId) => runtime.publishWorktreeRemovalChange(repoId),
        offlineHostOnly: true
      }
    )
  }
}

/**
 * The SSH host the caller named, once it is the one Pod has for this workspace. Reads the store only.
 * The desktop's forget takes an explicit host as the owner without comparing it; this one compares,
 * so a wrong host can't purge another host's partition of the same workspace id.
 */
export function resolveForgetHost(
  store: Pick<Store, 'getRepos' | 'getRepo' | 'getWorktreeMeta'>,
  params: PodWorktreeForgetLocalParams
): ExecutionHostId {
  const parsed = splitWorktreeId(params.worktreeId)
  if (!parsed?.repoId || !parsed.worktreePath) {
    throw new InvalidArgumentError(`Invalid worktreeId: ${params.worktreeId}`)
  }
  const host = parseExecutionHostId(params.hostId)
  if (host?.kind !== 'ssh') {
    throw podWorktreeForgetRefusal('unsupported_host')
  }
  const owner = resolveWorktreeRemovalRepoOwner(store, parsed.repoId, host.id)
  if (owner.kind === 'ambiguous') {
    throw podWorktreeForgetRefusal('ambiguous_host')
  }
  const meta = store.getWorktreeMeta(params.worktreeId)
  if (meta?.hostId && meta.hostId !== host.id) {
    throw podWorktreeForgetRefusal('host_mismatch')
  }
  if (owner.kind === 'resolved') {
    return host.id
  }
  // No project on this host: another host's project, or an orphan whose row names a host.
  if (store.getRepo(parsed.repoId) || store.getRepos().some((repo) => repo.id === parsed.repoId)) {
    throw podWorktreeForgetRefusal('host_mismatch')
  }
  if (!meta) {
    throw podWorktreeForgetRefusal('unknown_worktree')
  }
  if (meta.hostId !== host.id) {
    throw podWorktreeForgetRefusal('host_mismatch')
  }
  return host.id
}
