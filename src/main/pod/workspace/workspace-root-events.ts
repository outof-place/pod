import type { PodWorkspaceIndexStatus } from '../../../shared/pod-workspace-types'
import type { Repo } from '../../../shared/repo-types'
import { isLocalGitRepo, isPathInsideWorkspaceRoot } from './workspace-root-path'

// Seam for pod-search: which local git repos sit under the workspace root, and how they move.
// SSH, runtime-host and folder projects never produce events.

export type WorkspaceRootEvent =
  | { kind: 'added'; repoId: string; path: string }
  | { kind: 'removed'; repoId: string; path: string }
  | { kind: 'moved'; repoId: string; path: string; previousPath: string }

export type WorkspaceRootEntry = { repoId: string; path: string }

/** Per-worktree index state; the shape of one ogd `status` worktree entry. */
export type IndexStatus = PodWorkspaceIndexStatus

/** Answers for one checkout root; null when the index does not hold it. */
export type WorkspaceIndexStatusProvider = (root: string) => Promise<IndexStatus | null>

type Listener = (event: WorkspaceRootEvent) => void

const listeners = new Set<Listener>()
let tracked = new Map<string, string>()
let indexStatusProvider: WorkspaceIndexStatusProvider | null = null

/** Subscribe to repo roots entering, leaving or moving within the workspace root. */
export function onWorkspaceRootsChanged(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The roots as of the last sync; events only describe changes after it. */
export function listWorkspaceRoots(): WorkspaceRootEntry[] {
  return [...tracked].map(([repoId, path]) => ({ repoId, path }))
}

/** Repo id to path for local git repos under `root`; empty while the workspace is off. */
export function computeWorkspaceRoots(
  repos: readonly Repo[],
  root: string,
  enabled: boolean
): Map<string, string> {
  const roots = new Map<string, string>()
  if (!enabled) {
    return roots
  }
  for (const repo of repos) {
    if (isLocalGitRepo(repo) && isPathInsideWorkspaceRoot(repo.path, root)) {
      roots.set(repo.id, repo.path)
    }
  }
  return roots
}

export function diffWorkspaceRoots(
  previous: ReadonlyMap<string, string>,
  next: ReadonlyMap<string, string>
): WorkspaceRootEvent[] {
  const events: WorkspaceRootEvent[] = []
  for (const [repoId, path] of previous) {
    const nextPath = next.get(repoId)
    if (nextPath === undefined) {
      events.push({ kind: 'removed', repoId, path })
    } else if (nextPath !== path) {
      events.push({ kind: 'moved', repoId, path: nextPath, previousPath: path })
    }
  }
  for (const [repoId, path] of next) {
    if (!previous.has(repoId)) {
      events.push({ kind: 'added', repoId, path })
    }
  }
  return events
}

/** Adopts `next` without events: startup must not look like every repo was just added. */
export function primeWorkspaceRoots(next: ReadonlyMap<string, string>): void {
  tracked = new Map(next)
}

export function syncWorkspaceRoots(next: ReadonlyMap<string, string>): WorkspaceRootEvent[] {
  const events = diffWorkspaceRoots(tracked, next)
  tracked = new Map(next)
  for (const event of events) {
    for (const listener of listeners) {
      try {
        listener(event)
      } catch (error) {
        console.warn('[pod-workspace] root listener failed:', error)
      }
    }
  }
  return events
}

/** The index (pod-search) reports per-root status here; the dashboard reads it on demand. */
export function registerWorkspaceIndexStatusProvider(
  provider: WorkspaceIndexStatusProvider
): () => void {
  indexStatusProvider = provider
  return () => {
    if (indexStatusProvider === provider) {
      indexStatusProvider = null
    }
  }
}

export function getWorkspaceIndexStatusProvider(): WorkspaceIndexStatusProvider | null {
  return indexStatusProvider
}

export function resetWorkspaceRootEventsForTests(): void {
  listeners.clear()
  tracked = new Map()
  indexStatusProvider = null
}
