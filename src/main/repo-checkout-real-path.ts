import { realpathSync } from 'node:fs'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../shared/execution-host'
import type { Repo } from '../shared/repo-types'

const readsThisPass = new Map<string, string | undefined>()

/**
 * The real path of a local repo's checkout. Git lists a checkout by it, so a repo registered
 * through a symlink (`/tmp`, a folder Move In left a link at) needs it to find its own row.
 * Undefined for a repo on another host or a path that can't be read: callers keep `repo.path`.
 * Kept until the current synchronous pass ends, so a listing reads each repo once, not per row.
 */
export function readRepoCheckoutRealPath(
  repo: Pick<Repo, 'path' | 'connectionId' | 'executionHostId'>
): string | undefined {
  if (getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID) {
    return undefined
  }
  if (readsThisPass.has(repo.path)) {
    return readsThisPass.get(repo.path)
  }
  if (readsThisPass.size === 0) {
    queueMicrotask(() => readsThisPass.clear())
  }
  let realPath: string | undefined
  try {
    realPath = realpathSync(repo.path)
  } catch {
    realPath = undefined
  }
  readsThisPass.set(repo.path, realPath)
  return realPath
}
