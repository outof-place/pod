import type { GitHostFacts } from './workspace-git-profile-facts'
import { isPathInsideWorkspaceRoot } from './workspace-root-path'

// `git clone --ref-format` arrived with the reftable backend in 2.45.
const REFTABLE_MIN: readonly [number, number] = [2, 45]

export type PodCloneOptionsDeps = {
  isEnabled: () => boolean
  root: () => string
  hostFacts: () => Promise<GitHostFacts>
}

/**
 * New clones into the Pod root start on reftable (10k ref writes 1405 → 134 ms measured);
 * existing repos convert only when the user ticks it, and clones elsewhere stay as Orca makes them.
 */
export function createPodCloneOptions(deps: PodCloneOptionsDeps) {
  return async (clonePath: string): Promise<string[]> => {
    if (!deps.isEnabled() || !isPathInsideWorkspaceRoot(clonePath, deps.root())) {
      return []
    }
    const version = (await deps.hostFacts()).version
    const [major, minor] = REFTABLE_MIN
    const supported =
      version !== null && (version[0] > major || (version[0] === major && version[1] >= minor))
    return supported ? ['--ref-format=reftable'] : []
  }
}
