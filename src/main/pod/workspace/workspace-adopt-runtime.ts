// Fork-only (Pod): the runtime calls a Move In makes, bound per RPC call.
import { invalidateAuthorizedRootsCache } from '../../ipc/filesystem-auth'
import type { RuntimeTerminalListResult } from '../../../shared/runtime-terminal-contracts'
import type { AdoptRelinkRuntime } from './workspace-adopt-relink'

type AdoptRuntimeSurface = {
  listTerminals(worktreeSelector?: string): Promise<RuntimeTerminalListResult>
  notifyWorktreeFolderRenamed(repoId: string, oldWorktreeId: string, newWorktreeId: string): void
  /** Named for folder workspaces; it is the runtime's public repos-changed fan-out. */
  notifyFolderWorkspaceChanged(): void
}

export function createAdoptRuntimeHooks(runtime: AdoptRuntimeSurface): AdoptRelinkRuntime {
  return {
    liveTerminalWorktrees: async (worktreeIds) => {
      const live: string[] = []
      for (const worktreeId of worktreeIds) {
        // A worktree this runtime can't resolve holds none of its terminals.
        const listed = await runtime.listTerminals(`id:${worktreeId}`).catch(() => null)
        if (listed?.terminals.some((terminal) => terminal.ptyId !== null)) {
          live.push(worktreeId)
        }
      }
      return live
    },
    notifyWorktreeRenamed: (repoId, oldWorktreeId, newWorktreeId) =>
      runtime.notifyWorktreeFolderRenamed(repoId, oldWorktreeId, newWorktreeId),
    notifyReposChanged: () => {
      // File reads are allowed by repo path; the new path must be readable at once.
      invalidateAuthorizedRootsCache()
      runtime.notifyFolderWorkspaceChanged()
    }
  }
}
