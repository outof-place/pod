import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorktreeBasePollEvent } from './worktree-base-directory-poller'
import type { GitCommonEntrySnapshot } from './worktree-git-common-entry-snapshot'

// Every ref update in a reftable repo (Git ≥ 2.45) renames a fresh
// `reftable/tables.list` into place: the shared stack under the common dir, and
// a linked worktree's own stack (its HEAD and HEAD reflog) under its entry.
const STACK_LIST_PATH = join('reftable', 'tables.list')

export function isReftableStackListParts(parts: string[], offset: number): boolean {
  return (
    parts.length === offset + 2 &&
    parts[offset] === 'reftable' &&
    parts[offset + 1] === 'tables.list'
  )
}

async function stackListSignature(entryPath: string): Promise<string | null> {
  try {
    const value = await stat(join(entryPath, STACK_LIST_PATH))
    return value.isFile() ? `${value.mtimeMs}:${value.ctimeMs}:${value.ino}:${value.size}` : null
  } catch {
    return null
  }
}

/** A stack write never moves the entry dir's own signature, so a reftable
 *  entry re-stats its list every tick; entries without one (files backend)
 *  only probe when the entry is rescanned anyway. */
export async function readEntryReftableSignature(
  entryPath: string,
  previous: GitCommonEntrySnapshot | undefined,
  rescan: boolean
): Promise<string | null> {
  return rescan || previous?.reftableSignature
    ? stackListSignature(entryPath)
    : (previous?.reftableSignature ?? null)
}

export function diffEntryReftableSignature(
  entryPath: string,
  prev: GitCommonEntrySnapshot,
  next: GitCommonEntrySnapshot
): WorktreeBasePollEvent[] {
  const before = prev.reftableSignature ?? null
  const after = next.reftableSignature ?? null
  if (before === after) {
    return []
  }
  const type = before === null ? 'create' : after === null ? 'delete' : 'update'
  return [{ type, path: join(entryPath, STACK_LIST_PATH) }]
}
