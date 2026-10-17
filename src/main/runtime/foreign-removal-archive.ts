// Fork-only (Pod): a removal through the runtime (the CLI's `worktree rm --run-hooks`, an agent, a
// paired client) runs the archive script in a checkout of someone else's code only with the hash
// approved for this removal: an agent's flag is no user's approval.
import { getArchiveHooksForRemoval } from '../ipc/worktrees/removal/worktree-archive-hook'
import { untrustedRemovalArchive } from '../orca-yaml-setup-trust'
import type { Repo } from '../../shared/repo-types'
import {
  isForeignWorktree,
  type ForeignWorktreeFields
} from '../../shared/worktree/linked-code-review'

export async function assertForeignArchiveApproved(
  runtime: {
    showManagedWorktree(
      selector: string
    ): Promise<ForeignWorktreeFields & { repoId: string; path: string }>
    listRepos(): Repo[]
  },
  selector: string,
  approvedHash: string | undefined
): Promise<void> {
  // A worktree Git no longer lists has no checkout to run a script in; the removal handles it.
  const worktree = await runtime.showManagedWorktree(selector).catch(() => null)
  if (!worktree || !isForeignWorktree(worktree)) {
    return
  }
  const repo = runtime.listRepos().find((candidate) => candidate.id === worktree.repoId)
  if (!repo) {
    return
  }
  const hooks = await getArchiveHooksForRemoval(repo)
  const refused = untrustedRemovalArchive(true, hooks?.scripts.archive, approvedHash, worktree.path)
  if (refused) {
    throw refused
  }
}
