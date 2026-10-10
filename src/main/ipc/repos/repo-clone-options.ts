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
