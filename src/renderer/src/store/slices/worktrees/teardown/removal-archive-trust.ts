// Fork-only (Pod): the archive script's trust question before a removal runs it.
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { ensureHooksConfirmed } from '@/lib/ensure-hooks-confirmed'
import { getRepoIdFromWorktreeId } from '../../worktree-helpers'
import type { WorktreeSliceGet } from '../listing/worktree-slice-types'
import { isForeignWorktree } from '../../../../../../shared/worktree/linked-code-review'

/** Whether the archive script must not run (`skip`). `get`: same-repo local deletes start together,
 *  and one approval must cover the rest; a checkout of someone else's code asks every time, since
 *  the root's script runs in it and a script it calls can be that branch's, and its approved hash
 *  goes with the removal (`archiveTrustHash`), which the host checks. */
export async function confirmRemovalArchive(
  get: WorktreeSliceGet,
  worktreeId: string,
  hostId: ExecutionHostId | undefined,
  runtimeEnvironmentId: string | null | undefined
): Promise<{ skip: boolean; archiveTrustHash?: string }> {
  // Any row by this id: a same-id row on another host only makes it ask once more.
  const foreign = get()
    .allWorktrees()
    .some((entry) => entry.id === worktreeId && isForeignWorktree(entry))
  let archiveTrustHash: string | undefined
  const decision = await ensureHooksConfirmed(
    get,
    getRepoIdFromWorktreeId(worktreeId),
    'archive',
    hostId,
    runtimeEnvironmentId,
    undefined,
    foreign ? { foreign: true, onTrusted: (hash) => (archiveTrustHash = hash) } : undefined
  )
  return decision === 'skip' ? { skip: true } : { skip: false, archiveTrustHash }
}
