// Fork-only (Pod): the path arithmetic of a Move In: which folders move, and where a path inside
// one of them lands.
import { lstat } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { PodAdoptRecord } from '../../../shared/pod-workspace-tidy-types'
import type { Repo } from '../../../shared/repo-types'
import { splitWorktreeIdForFilesystem } from '../../../shared/worktree/id'
import type { WorkspaceJournal } from './workspace-journal'
import { podWorktreesDirOf as worktreesDirOf } from './workspace-tidy-strays'

/** `[from, to]`: a folder Move In renames. */
export type AdoptMove = readonly [string, string]

/** Claude Code keys a project's history by its cwd with every non-alphanumeric as `-`. */
export function claudeProjectKey(path: string): string {
  return path.replace(/[^A-Za-z0-9]/g, '-')
}

/**
 * A path inside a moved folder, re-rooted at the folder's new place. Case-insensitive, as APFS
 * is by default: a path stored as `~/Documents/App` is the same folder as git's `~/Documents/app`.
 */
export function remapPath(path: string, moves: readonly AdoptMove[]): string {
  const folded = path.toLowerCase()
  for (const [from, to] of moves) {
    const prefix = from.toLowerCase()
    if (folded === prefix || folded.startsWith(`${prefix}/`)) {
      return to + path.slice(from.length)
    }
  }
  return path
}

export function reverseMoves(moves: readonly AdoptMove[]): AdoptMove[] {
  return moves.map(([from, to]) => [to, from] as const)
}

export function pathOfWorktreeId(worktreeId: string): string {
  return splitWorktreeIdForFilesystem(worktreeId)?.worktreePath ?? worktreeId
}

export async function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false
  )
}

/** Writes the record as it stands now, so a crash or a failed step still leaves Move Back a map. */
export function saveAdoptRecord(journal: WorkspaceJournal, record: PodAdoptRecord): Promise<void> {
  return journal.update((data) => {
    data.adoptions = [...data.adoptions.filter((entry) => entry.id !== record.id), record]
  })
}

export async function nearestExisting(path: string): Promise<string> {
  let current = path
  while (!(await pathExists(current)) && dirname(current) !== current) {
    current = dirname(current)
  }
  return current
}

/** The folders a Move In renames, under each spelling Pod or git may know them by. */
export function movesOf(
  repo: Repo,
  from: string,
  to: string,
  worktreesDir: string | null
): AdoptMove[] {
  const moves: AdoptMove[] = [[from, to]]
  if (worktreesDir) {
    moves.push([worktreesDir, worktreesDirOf(to)])
  }
  if (repo.path !== from) {
    moves.push([repo.path, to])
    if (worktreesDir) {
      moves.push([worktreesDirOf(repo.path), worktreesDirOf(to)])
    }
  }
  return moves
}
