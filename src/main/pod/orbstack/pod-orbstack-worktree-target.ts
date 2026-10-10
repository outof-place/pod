import { statSync } from 'node:fs'
import type { Repo } from '../../../shared/repo-types'
import { getRepoIdFromWorktreeId, splitWorktreeIdForFilesystem } from '../../../shared/worktree/id'
import type { PodOrbstackWorktreeTarget } from './pod-orbstack-machines'

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Machines open the worktree in place, so only a local checkout on this Mac qualifies. */
export function resolveLocalWorktreeTarget(
  worktreeId: string,
  displayName: string | null,
  repos: readonly Repo[],
  isDir: (path: string) => boolean = isDirectory
): PodOrbstackWorktreeTarget | string {
  const repo = repos.find((entry) => entry.id === getRepoIdFromWorktreeId(worktreeId))
  if (!repo) {
    return 'Unknown worktree.'
  }
  if (repo.connectionId || (repo.executionHostId && repo.executionHostId !== 'local')) {
    return 'OrbStack machines are for worktrees on this Mac, not remote ones.'
  }
  const parsed = splitWorktreeIdForFilesystem(worktreeId)
  if (!parsed || !parsed.worktreePath.startsWith('/') || !isDir(parsed.worktreePath)) {
    return 'The worktree folder does not exist.'
  }
  return { worktreeId, worktreePath: parsed.worktreePath, displayName: displayName ?? '' }
}
