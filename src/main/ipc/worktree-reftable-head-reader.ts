import { join } from 'node:path'
import type { WorktreeHeadIdentity } from '../../shared/worktree/types'
import {
  createReftableReader,
  REFTABLE_UNREADABLE,
  type ReftableReader,
  type ReftableRef
} from '../git/reftable-stack-reader'

export { REFTABLE_HEAD_PLACEHOLDER } from '../git/reftable-stack-reader'

const MAX_SYMREF_DEPTH = 5
// Git keeps root refs (HEAD, ORIG_HEAD…) and these namespaces per worktree.
const PER_WORKTREE_REF = /^(?:[A-Z_-]+|refs\/(?:worktree|bisect|rewritten)\/.*)$/

// Keyed by the pass's `resolved` map: one consistent tables.list read per stack per pass.
const passReaders = new WeakMap<object, ReftableReader>()

/** HEAD and branch tip of one checkout in a reftable repo, read from its own
 *  stack (per-worktree refs) and the shared stack (branches). Records the
 *  branch outcome in `resolved` like the files-backend path does; any read
 *  failure other than absence returns the caller's `unreadable` sentinel. */
export async function readReftableHeadIdentity<Unreadable>(
  commonDirPath: string,
  adminDirPath: string,
  worktreePath: string,
  resolved: Map<string, string | null>,
  unreadable: Unreadable
): Promise<WorktreeHeadIdentity | null | Unreadable> {
  let read = passReaders.get(resolved)
  if (!read) {
    read = createReftableReader()
    passReaders.set(resolved, read)
  }
  const stackFor = (name: string): string =>
    join(PER_WORKTREE_REF.test(name) ? adminDirPath : commonDirPath, 'reftable')
  const head = await read(stackFor('HEAD'), 'HEAD')
  if (head === REFTABLE_UNREADABLE) {
    return unreadable
  }
  if (head === null) {
    return null
  }
  if (head.kind === 'oid') {
    return { worktreePath, head: head.oid, branch: null }
  }
  const branch = head.target
  let ref: ReftableRef = head
  for (let depth = 0; ref.kind === 'symref' && depth < MAX_SYMREF_DEPTH; depth++) {
    const next = await read(stackFor(ref.target), ref.target)
    if (next === REFTABLE_UNREADABLE) {
      return unreadable
    }
    if (next === null) {
      break
    }
    ref = next
  }
  const oid = ref.kind === 'oid' ? ref.oid : null
  resolved.set(branch, oid)
  // Unborn branches stay covered by the structural listing, as in the files path.
  return oid ? { worktreePath, head: oid, branch } : null
}
