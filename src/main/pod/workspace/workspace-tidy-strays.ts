import { readdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { PodTidyStrayFolder } from '../../../shared/pod-workspace-tidy-types'
import type { Repo } from '../../../shared/repo-types'
import {
  buildWorkspaceCleanupStrayGuard,
  scanWorkspaceCleanupStrayDirectories
} from '../../ipc/workspace-cleanup-stray-directories'
import { classifyWorkspaceCleanupStrayDirectory } from '../../ipc/workspace-cleanup-stray-directory-classifier'
import type { WorkspaceCleanupStrayStore } from '../../ipc/workspace-cleanup-stray-directory-roots'
import { fingerprintOf } from './workspace-plan-store'

export type WorkspaceStrayStore = WorkspaceCleanupStrayStore

const MAX_POD_ROOT_ENTRIES = 200

/** Pod's own layout keeps linked worktrees next to the repo, in `<repo>.worktrees/`. */
export function podWorktreesDirOf(repoPath: string): string {
  return join(dirname(repoPath), `${basename(repoPath)}.worktrees`)
}

function folder(repoId: string, path: string, modifiedAt: number): PodTidyStrayFolder {
  return { repoId, path, modifiedAt, fingerprint: fingerprintOf([path, modifiedAt]) }
}

/**
 * Unregistered folders in Orca's worktree roots (#27020's scan, all of its refusals) and in
 * Pod's `<repo>.worktrees/`, judged by #27020's own classifier.
 */
export async function scanStrayFolders(
  store: WorkspaceStrayStore,
  repos: readonly Repo[],
  registered: readonly string[],
  now: number
): Promise<PodTidyStrayFolder[]> {
  const scopeIds = new Set(repos.map((repo) => repo.id))
  const out = new Map<string, PodTidyStrayFolder>()
  const orca = await scanWorkspaceCleanupStrayDirectories({
    store,
    registeredWorktreePaths: registered,
    scannedAt: now
  }).catch(() => undefined)
  for (const directory of orca?.directories ?? []) {
    const repoId = directory.repoIds.find((id) => scopeIds.has(id))
    if (repoId) {
      out.set(directory.path, folder(repoId, directory.path, directory.lastModifiedAt))
    }
  }
  const owned = [...registered, ...store.getRepos().map((repo) => repo.path)]
  const guard = buildWorkspaceCleanupStrayGuard(owned)
  for (const repo of repos) {
    const parent = podWorktreesDirOf(repo.path)
    const names = await readdir(parent).catch(() => [])
    for (const name of names
      .filter((entry) => !entry.startsWith('.'))
      .slice(0, MAX_POD_ROOT_ENTRIES)) {
      const path = join(parent, name)
      const verdict = await classifyWorkspaceCleanupStrayDirectory(path, guard, now)
      if (verdict.stray && !out.has(path)) {
        out.set(path, folder(repo.id, path, verdict.lastModifiedAt))
      }
    }
  }
  return [...out.values()]
}
