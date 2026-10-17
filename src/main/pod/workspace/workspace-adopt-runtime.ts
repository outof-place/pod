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
        try {
          const listed = await runtime.listTerminals(`id:${worktreeId}`)
          if (listed.terminals.some((terminal) => terminal.ptyId !== null)) {
            live.push(worktreeId)
          }
        } catch (error) {
          // A worktree this runtime can't resolve holds none of its terminals; any other failure
          // counts as open, since the check exists to keep a running pane from being re-keyed.
          if (!(error instanceof Error && error.message === 'selector_not_found')) {
            live.push(worktreeId)
          }
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
