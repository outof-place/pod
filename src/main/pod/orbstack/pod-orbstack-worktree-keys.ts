// Fork-only (Pod): what Pod Workspace's Move In asks of OrbStack's registry. A machine's mounts
// name the worktree's folder, so a moving worktree with machines is refused; its docker pin and
// its sandbox-by-default choice follow it to the new id.
export type PodOrbstackWorktreeKeys = {
  /** Names of the machines Pod created for any of these worktrees. */
  machinesFor(worktreeIds: readonly string[]): string[]
  /** Re-keys pins and sandbox flags; returns each `[old, new]` it changed. */
  rekey(pairs: readonly (readonly [string, string])[]): [string, string][]
}

let keys: PodOrbstackWorktreeKeys | null = null

/** Set once by installPodOrbstack; null before it runs or where OrbStack support is absent. */
export function setPodOrbstackWorktreeKeys(value: PodOrbstackWorktreeKeys | null): void {
  keys = value
}

export function getPodOrbstackWorktreeKeys(): PodOrbstackWorktreeKeys | null {
  return keys
}
