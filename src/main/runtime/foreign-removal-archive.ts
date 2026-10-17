// Fork-only (Pod): a removal through the runtime (the CLI's `worktree rm --run-hooks`, an agent, a
// paired client) runs the archive script in a checkout of someone else's code only with the hash
// approved for this removal: an agent's flag is no user's approval. The check sits where that
// script runs, on the worktree, repo and host the removal resolved itself, so no lookup of its own
// can fail open or find another host's worktree. The approved hash rides the removal's async
// context: a removal without one (an internal caller, an older client) has none to show.
import { AsyncLocalStorage } from 'node:async_hooks'
import { untrustedRemovalArchive } from '../orca-yaml-setup-trust'
import {
  isForeignWorktree,
  type ForeignWorktreeFields
} from '../../shared/worktree/linked-code-review'

const approvedArchive = new AsyncLocalStorage<string | undefined>()

/** Runs a removal with the archive script hash its request approved. */
export function withApprovedArchive<T>(
  approvedHash: string | undefined,
  removal: () => Promise<T>
): Promise<T> {
  return approvedArchive.run(approvedHash, removal)
}

/** Throws, before anything is stopped or deleted, when the archive script about to run in a
 *  checkout of someone else's code (`meta`) lacks this removal's approval. */
export function assertForeignArchiveApproved(
  meta: ForeignWorktreeFields | undefined,
  archiveScript: string,
  worktreePath: string
): void {
  const foreign = meta !== undefined && isForeignWorktree(meta)
  const approvedHash = approvedArchive.getStore()
  const refused = untrustedRemovalArchive(foreign, archiveScript, approvedHash, worktreePath)
  if (refused) {
    throw refused
  }
}
