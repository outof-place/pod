// Fork-only (Pod): worktrees:forgetLocal's body, moved here unchanged so the runtime RPC
// worktree.forgetLocal runs the same forget. Pod's own state for the workspace goes; its directory,
// its Git registration and the host's files are never touched.
//
// Upstream: the sync with Orca ended on 2026-10-13 (CONTRIBUTING.md). Should a change to Orca's
// worktrees:forgetLocal ever be taken, its body is here, not in register-worktree-forget-handlers.ts.
import type { RemoveWorktreeResult } from '../../../shared/worktree/create-types'
import { parseWorktreeId } from '../../ipc/worktree-logic'
import { resolveWorktreeRemovalRepoOwner } from '../../worktree-removal-repo-owner'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../shared/execution-host'
import type { Repo } from '../../../shared/repo-types'
import { isFolderRepo } from '../../../shared/repo-kind'
import { getSshPtyProvider, getLocalPtyProvider, clearProviderPtyState } from '../../ipc/pty'
import { killAllProcessesForWorktree } from '../../runtime/worktree-teardown'
import { invalidateAuthorizedRootsCache } from '../../ipc/registered-worktree-roots-cache'
import { preservedBranchCleanupScopeKey } from '../../../shared/preserved-branch-cleanup'
import type { RemoveWorktreeArgs } from '../../ipc/worktrees/ipc-context-schemas'
import {
  getWorktreeRemovalInFlightKey,
  type WorktreeRemovalInFlight
} from '../../ipc/worktrees/removal/worktree-removal-coordinator'
import { getFolderWorkspaceRootId } from '../../ipc/worktrees/folder-workspace-model'
import {
  removeWorktreeMetadataAndTransientState,
  resolveWorktreeRemovalOwnerHostId
} from '../../ipc/worktrees/removal/worktree-removal-ownership'
import { preservedBranchCleanupByScope } from '../../ipc/worktrees/removal/preserved-branch-cleanup'
import type { Store } from '../../persistence/loading-store/store'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { podWorktreeForgetRefusal } from './pod-worktree-forget-refusal'

export type ForgetLocalWorktreeArgs = Pick<
  RemoveWorktreeArgs,
  'worktreeId' | 'hostId' | 'snapshotPruneBatchId'
>

export type ForgetLocalWorktreeDeps = {
  store: Store
  runtime: OrcaRuntimeService
  /** The desktop's removal registry, so a forget and a removal of one workspace never overlap. */
  removalsInFlight: Map<string, WorktreeRemovalInFlight>
  /** After the purge: the window's IPC tells its window and RPC clients; the RPC tells every client. */
  notifyChanged: (repoId: string) => void
  /**
   * The RPC's forget: refuses a host whose SSH provider is connected, before anything changes. A
   * forget of the same workspace already running from the window is joined before that check, so
   * with a connected host the RPC returns that forget's result, which Pod's dialog confirmed; the
   * RPC itself still touches nothing on the host.
   */
  offlineHostOnly?: true
}

export async function forgetLocalWorktree(
  args: ForgetLocalWorktreeArgs,
  deps: ForgetLocalWorktreeDeps
): Promise<RemoveWorktreeResult> {
  const { store, runtime, removalsInFlight: worktreeRemovalsInFlight } = deps
  const { repoId } = parseWorktreeId(args.worktreeId)
  const repoOwner = resolveWorktreeRemovalRepoOwner(store, repoId, args.hostId)
  if (!args.hostId && repoOwner.kind === 'ambiguous') {
    throw new Error(
      `Workspace identity is ambiguous across hosts: ${args.worktreeId}. Retry with an explicit host.`
    )
  }
  const repo = repoOwner.kind === 'resolved' ? repoOwner.repo : undefined
  // Repo-first (unlike owner resolution below) so this key matches worktrees:remove's; meta only covers ownerless forgets.
  const inFlightKey = getWorktreeRemovalInFlightKey(
    args.worktreeId,
    repo
      ? getRepoExecutionHostId(repo)
      : (args.hostId ?? store.getWorktreeMeta(args.worktreeId)?.hostId)
  )
  const optionsKey = 'forget-local'
  const inFlight = worktreeRemovalsInFlight.get(inFlightKey)
  if (inFlight) {
    if (inFlight.optionsKey === optionsKey) {
      return inFlight.promise
    }
    throw new Error(`Worktree deletion already in progress: ${args.worktreeId}`)
  }

  const forget = (async (): Promise<RemoveWorktreeResult> => {
    const isFolderRootOf = (candidate: Repo): boolean =>
      isFolderRepo(candidate) && args.worktreeId === getFolderWorkspaceRootId(candidate)
    const fallbackRepos = args.hostId
      ? store.getRepos().filter((candidate) => getRepoExecutionHostId(candidate) === args.hostId)
      : store.getRepos()
    if (repo ? isFolderRootOf(repo) : fallbackRepos.some(isFolderRootOf)) {
      throw new Error(
        'Cannot delete the project root workspace. Remove the folder project instead.'
      )
    }

    const ownerHostId = resolveWorktreeRemovalOwnerHostId(store, args.worktreeId, repo, args.hostId)
    const ownerHost = parseExecutionHostId(ownerHostId)
    const sshPtyProvider =
      ownerHost?.kind === 'ssh' ? getSshPtyProvider(ownerHost.targetId) : undefined
    // Fork-only (Pod): the RPC's forget never reaches a host; Pod's window asks first in its dialog.
    if (deps.offlineHostOnly && sshPtyProvider) {
      throw podWorktreeForgetRefusal('host_connected')
    }
    const externalHost = ownerHost?.kind === 'ssh' || ownerHost?.kind === 'runtime'
    // External host inventories must never sweep a same-id local workspace.
    await killAllProcessesForWorktree(args.worktreeId, {
      runtime,
      resolvedWorktreeId: args.worktreeId,
      ...(ownerHost?.kind === 'ssh' ? { resolvedConnectionId: ownerHost.targetId } : {}),
      ...(ownerHost?.kind === 'runtime'
        ? { resolvedRuntimeEnvironmentId: ownerHost.environmentId }
        : {}),
      localProvider: sshPtyProvider ?? getLocalPtyProvider(),
      onPtyStopped: clearProviderPtyState,
      // Forgetting an orphan still purges its workspace metadata, so retire structured chat
      // tabs even when no provider child is attached to the workspace.
      closeStructuredSessions: true,
      ...(externalHost
        ? {
            includeProviderInventory: ownerHost?.kind === 'ssh' && Boolean(sshPtyProvider),
            includeLocalRegistry: false
          }
        : {})
    }).catch((err) => {
      console.warn(`[worktree-teardown] forget-local failed for ${args.worktreeId}:`, err)
    })

    runtime.clearOptimisticReconcileToken(args.worktreeId)
    // The resolved owner, not args.hostId: an orphan forget with no hostId still has to purge its SSH/runtime partition.
    removeWorktreeMetadataAndTransientState(
      store,
      args.worktreeId,
      ownerHost?.id,
      args.snapshotPruneBatchId
    )
    // Why: cached roots outlive the forgotten workspace, so an ownerless path stays filesystem-authorized until a rebuild.
    invalidateAuthorizedRootsCache()
    if (ownerHost?.id) {
      preservedBranchCleanupByScope.delete(
        preservedBranchCleanupScopeKey({ worktreeId: args.worktreeId, hostId: ownerHost.id })
      )
    } else {
      for (const [key, target] of preservedBranchCleanupByScope) {
        if (target.worktreeId === args.worktreeId) {
          preservedBranchCleanupByScope.delete(key)
        }
      }
    }
    deps.notifyChanged(repoId)
    return {}
  })()
  worktreeRemovalsInFlight.set(inFlightKey, { optionsKey, promise: forget })
  try {
    return await forget
  } finally {
    if (worktreeRemovalsInFlight.get(inFlightKey)?.promise === forget) {
      worktreeRemovalsInFlight.delete(inFlightKey)
    }
  }
}
