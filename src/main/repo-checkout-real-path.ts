import { realpath } from 'node:fs/promises'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../shared/execution-host'
import type { Repo } from '../shared/repo-types'

type CheckoutRepo = Pick<Repo, 'path' | 'connectionId' | 'executionHostId'>

/** Local checkouts' real paths by `repo.path`; repos on other hosts and unreadable paths are absent. */
export type RepoCheckoutRealPaths = ReadonlyMap<string, string>

// Why: an SSH repo's path names a remote filesystem, so a local realpath of it would be a guess.
function isLocalCheckout(repo: CheckoutRepo): boolean {
  return getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID
}

/**
 * The real path of a local repo's checkout. Git lists a checkout by it, so a repo registered
 * through a symlink (`/tmp`, a folder Move In left a link at) needs it to find its own row.
 * Undefined for a repo on another host or a path that can't be read: callers keep `repo.path`.
 */
export async function readRepoCheckoutRealPath(repo: CheckoutRepo): Promise<string | undefined> {
  return isLocalCheckout(repo) ? await realpath(repo.path).catch(() => undefined) : undefined
}

/** One read per distinct local repo path, for a listing pass over these repos. */
export async function readRepoCheckoutRealPaths(
  repos: readonly CheckoutRepo[]
): Promise<RepoCheckoutRealPaths> {
  const paths = [...new Set(repos.filter(isLocalCheckout).map((repo) => repo.path))]
  const reads = await Promise.all(
    paths.map(async (path) => [path, await realpath(path).catch(() => undefined)] as const)
  )
  return new Map(reads.filter((read): read is readonly [string, string] => read[1] !== undefined))
}

export function repoCheckoutRealPathIn(
  repo: CheckoutRepo,
  realPaths: RepoCheckoutRealPaths | undefined
): string | undefined {
  return realPaths && isLocalCheckout(repo) ? realPaths.get(repo.path) : undefined
}
