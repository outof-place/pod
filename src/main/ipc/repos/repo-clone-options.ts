import type { Repo } from '../../../shared/repo-types'

let cloneOptionsOverride: ((clonePath: string) => Promise<string[]>) | null = null

/** Downstream seam (Pod): extra `git clone` options for a clone on this machine. */
export function setLocalCloneOptionsOverride(
  override: ((clonePath: string) => Promise<string[]>) | null
): void {
  cloneOptionsOverride = override
}

/** Options go before `--`, so a URL is never read as one; a failing override adds none. */
export async function localCloneOptions(clonePath: string): Promise<string[]> {
  return (await cloneOptionsOverride?.(clonePath).catch(() => [])) ?? []
}

let cloneAddedListener: ((repo: Repo) => Promise<void>) | null = null

/** Downstream seam (Pod): runs after a clone on this machine is saved as a project. */
export function setLocalCloneAddedListener(listener: ((repo: Repo) => Promise<void>) | null): void {
  cloneAddedListener = listener
}

/** Waited for, so the clone returns with its setup done; a failing listener never fails it. */
export async function localCloneAdded(repo: Repo): Promise<void> {
  await cloneAddedListener?.(repo).catch(() => undefined)
}
