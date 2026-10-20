import { ipcMain } from 'electron'
import type {
  RemoveWorktreeResult,
  ForceDeleteWorktreeBranchResult
} from '../../../../shared/worktree/create-types'
import { parseWorktreeId } from '../../worktree-logic'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { preservedBranchCleanupScopeKey } from '../../../../shared/preserved-branch-cleanup'
import {
  notifyWorktreesChanged,
  cleanupUnusedWorktreePushTargetRemoteSsh,
  cleanupUnusedWorktreePushTargetRemote
} from '../../worktree-remote'
import { requireSshGitProvider } from '../../../providers/ssh-git-dispatch'
import { getLocalProjectWorktreeGitOptions } from '../../../project-runtime-git-options'
import { forceDeleteLocalBranch } from '../../../git/worktree'
import { gitExecFileAsync } from '../../../git/runner'
import type { RemoveWorktreeArgs } from '../ipc-context-schemas'
import { resolveRepoForExecutionHost } from '../repo-host-ownership'
import {
  getPreservedBranchCleanupTarget,
  preservedBranchCleanupByScope
} from './preserved-branch-cleanup'
import type { WorktreeIpcContext } from '../worktree-ipc-context'
import { forgetLocalWorktree } from '../../../pod/worktrees/pod-worktree-forget-local'

export function registerWorktreeForgetHandlers(context: WorktreeIpcContext): void {
  const { mainWindow, store, runtime, worktreeRemovalsInFlight } = context

  ipcMain.handle(
    'worktrees:forgetLocal',
    async (
      _event,
      args: Pick<RemoveWorktreeArgs, 'worktreeId' | 'hostId' | 'snapshotPruneBatchId'>
    ): Promise<RemoveWorktreeResult> =>
      // Fork-only (Pod): the body is forgetLocalWorktree, shared with the RPC worktree.forgetLocal.
      forgetLocalWorktree(args, {
        store,
        runtime,
        removalsInFlight: worktreeRemovalsInFlight,
        notifyChanged: (repoId) => {
          notifyWorktreesChanged(mainWindow, repoId)
          // Fork-only (Pod): RPC clients (PodNative, mobile) see the forget too.
          runtime.notifyWorktreesChangedForRemoteClients(repoId)
        }
      })
  )

  ipcMain.handle(
    'worktrees:forceDeletePreservedBranch',
    async (
      _event,
      args: {
        worktreeId: string
        branchName: string
        expectedHead: string
        hostId?: ExecutionHostId
      }
    ): Promise<ForceDeleteWorktreeBranchResult> => {
      const { repoId } = parseWorktreeId(args.worktreeId)
      const cleanupTarget = getPreservedBranchCleanupTarget(
        args.worktreeId,
        args.branchName,
        args.expectedHead,
        args.hostId
      )
      const repo = resolveRepoForExecutionHost(store, repoId, cleanupTarget.hostId)
      if (!repo) {
        throw new Error(`Repo not found: ${repoId}`)
      }
      if (isFolderRepo(repo)) {
        throw new Error('Folder workspaces do not have local Git branches.')
      }

      if (repo.connectionId) {
        const provider = requireSshGitProvider(repo.connectionId)
        // Why: SSH needs the write-capable relay RPC; the read-only git.exec allowlist rejects these worktree/update-ref/config writes.
        await provider.forceDeletePreservedBranch(
          repo.path,
          cleanupTarget.branchName,
          cleanupTarget.head
        )
        await cleanupUnusedWorktreePushTargetRemoteSsh(
          provider,
          repo.path,
          args.worktreeId,
          cleanupTarget.pushTarget,
          store
        )
      } else {
        const localWorktreeGitOptions = getLocalProjectWorktreeGitOptions(store, repo)
        const hasLocalWorktreeGitOptions = Object.keys(localWorktreeGitOptions).length > 0
        await (hasLocalWorktreeGitOptions
          ? forceDeleteLocalBranch(
              repo.path,
              cleanupTarget.branchName,
              cleanupTarget.head,
              (argv, cwd) => gitExecFileAsync(argv, { cwd, ...localWorktreeGitOptions }),
              localWorktreeGitOptions
            )
          : forceDeleteLocalBranch(repo.path, cleanupTarget.branchName, cleanupTarget.head))
        await cleanupUnusedWorktreePushTargetRemote(
          repo.path,
          args.worktreeId,
          cleanupTarget.pushTarget,
          store,
          localWorktreeGitOptions
        )
      }

      preservedBranchCleanupByScope.delete(
        preservedBranchCleanupScopeKey({
          worktreeId: args.worktreeId,
          hostId: cleanupTarget.hostId
        })
      )
      return { deleted: true }
    }
  )
}
