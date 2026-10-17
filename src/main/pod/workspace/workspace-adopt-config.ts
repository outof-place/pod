// Fork-only (Pod): absolute paths git keeps into a repo Move In renames: the repo's own config
// (core.hooksPath and the like) and the user's `maintenance.repo` entries.
import type { PodAdoptConfigPath } from '../../../shared/pod-workspace-tidy-types'
import { remapPath, type AdoptMove } from './workspace-adopt-paths'
import type { WorkspaceGitExec } from './workspace-git-exec'

/** `git config --list -z`: `key\nvalue` per entry; a key set with no value has no newline. */
function parseConfigList(stdout: string): [string, string][] {
  return stdout
    .split('\0')
    .filter((entry) => entry.includes('\n'))
    .map((entry) => [entry.slice(0, entry.indexOf('\n')), entry.slice(entry.indexOf('\n') + 1)])
}

export async function findConfigPaths(
  git: WorkspaceGitExec,
  repoPath: string,
  repoPathAfter: string,
  moves: readonly AdoptMove[]
): Promise<PodAdoptConfigPath[]> {
  const [local, global] = await Promise.all([
    git(['config', '--local', '--list', '-z'], repoPath),
    git(['config', '--global', '--get-all', 'maintenance.repo'], repoPath)
  ])
  const found: PodAdoptConfigPath[] = []
  for (const [key, value] of local.code === 0 ? parseConfigList(local.stdout) : []) {
    if (remapPath(value, moves) !== value) {
      found.push({ scope: 'local', key, from: value, to: remapPath(value, moves) })
    }
  }
  for (const value of global.code === 0 ? global.stdout.split('\n').filter(Boolean) : []) {
    const next = value === repoPath ? repoPathAfter : remapPath(value, moves)
    if (next !== value) {
      found.push({ scope: 'global', key: 'maintenance.repo', from: value, to: next })
    }
  }
  return found
}

/**
 * Replaces `previous` with `value` only while the key still holds `previous`: `--replace-all`
 * with a pattern nothing matches would add a second value over whatever the user set since.
 */
export async function rewriteConfigPath(
  git: WorkspaceGitExec,
  entry: PodAdoptConfigPath,
  value: string,
  previous: string,
  cwd: string
): Promise<boolean> {
  const scope = `--${entry.scope}`
  const holds = await git(['config', scope, '--get-all', '--fixed-value', entry.key, previous], cwd)
  if (holds.code !== 0) {
    return false
  }
  const write = ['config', scope, '--fixed-value', '--replace-all', entry.key, value, previous]
  return (await git(write, cwd)).code === 0
}
