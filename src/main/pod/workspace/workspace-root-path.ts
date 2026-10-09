import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { Repo } from '../../../shared/repo-types'
import { LOCAL_EXECUTION_HOST_ID, getRepoExecutionHostId } from '../../../shared/execution-host'
import { isGitRepoKind } from '../../../shared/repo-kind'
import { POD_WORKSPACE_DEFAULT_ROOT } from '../../../shared/pod-workspace-types'

/** Expands a leading `~`; null for a blank or relative value, which names no root. */
export function expandWorkspaceRoot(value: string, home: string = homedir()): string | null {
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }
  const expanded =
    trimmed === '~' ? home : trimmed.startsWith('~/') ? join(home, trimmed.slice(2)) : trimmed
  return isAbsolute(expanded) ? resolve(expanded) : null
}

export function workspaceRootSetting(settings: Pick<GlobalSettings, 'podWorkspaceRoot'>): string {
  return settings.podWorkspaceRoot?.trim() || POD_WORKSPACE_DEFAULT_ROOT
}

/** The configured root, falling back to `~/pod` when the setting names none. */
export function resolveWorkspaceRoot(
  settings: Pick<GlobalSettings, 'podWorkspaceRoot'>,
  home: string = homedir()
): string {
  return (
    expandWorkspaceRoot(workspaceRootSetting(settings), home) ??
    join(home, POD_WORKSPACE_DEFAULT_ROOT.slice(2))
  )
}

/** True for `root` itself and anything below it; string-based, so symlinks are not followed. */
export function isPathInsideRoot(candidate: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

const realRootCache = new Map<string, string>()

/**
 * The root as configured plus its real path: repos added through a picker are stored
 * resolved, so a symlinked root (`/var` vs `/private/var`) must match either spelling.
 */
export function workspaceRootAliases(root: string): string[] {
  let real = realRootCache.get(root)
  if (real === undefined) {
    try {
      // One stat-sized call per distinct root value; cached because the root rarely changes.
      real = realpathSync(root)
    } catch {
      return [root]
    }
    realRootCache.set(root, real)
  }
  return real === root ? [root] : [root, real]
}

export function isPathInsideWorkspaceRoot(candidate: string, root: string): boolean {
  return workspaceRootAliases(root).some((alias) => isPathInsideRoot(candidate, alias))
}

/** Pod manages only git repos on this machine: SSH, runtime-host and folder projects stay out. */
export function isLocalGitRepo(repo: Repo): boolean {
  return isGitRepoKind(repo) && getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID
}
