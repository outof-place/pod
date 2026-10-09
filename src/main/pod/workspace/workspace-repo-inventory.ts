import { gitExecFileAsync } from '../../git/runner'
import type { PodWorkspaceGitTuning } from '../../../shared/pod-workspace-types'

/** Runs a read-only git command; null on any failure, including a non-zero exit. */
export type WorkspaceGitRunner = (args: string[], cwd: string) => Promise<string | null>

const GIT_READ_TIMEOUT_MS = 5_000

export function createWorkspaceGitRunner(): WorkspaceGitRunner {
  return async (args, cwd) => {
    try {
      const { stdout } = await gitExecFileAsync(args, {
        cwd,
        timeout: GIT_READ_TIMEOUT_MS,
        // Why background: a health check must queue behind status reads the UI is waiting on.
        admissionTier: 'background'
      })
      return stdout
    } catch {
      return null
    }
  }
}

const TUNING_KEYS = {
  'core.untrackedcache': 'untrackedCache',
  'core.fsmonitor': 'fsmonitor',
  'index.version': 'indexVersion',
  'checkout.workers': 'checkoutWorkers',
  'orca.performanceconfig': 'orcaPerformanceConfig'
} as const satisfies Record<string, keyof PodWorkspaceGitTuning>

// git reports canonical (lowercased) key names, which is what the pattern matches.
const TUNING_KEY_PATTERN = `^(${Object.keys(TUNING_KEYS)
  .map((key) => key.replace('.', '\\.'))
  .join('|')})$`

function isTuningKey(key: string): key is keyof typeof TUNING_KEYS {
  return Object.hasOwn(TUNING_KEYS, key)
}

/** Reads the tuning git config; Pod reports it and never writes it. */
export function parseGitTuning(stdout: string | null): PodWorkspaceGitTuning {
  const tuning: PodWorkspaceGitTuning = {
    untrackedCache: null,
    fsmonitor: null,
    indexVersion: null,
    checkoutWorkers: null,
    orcaPerformanceConfig: null
  }
  for (const line of (stdout ?? '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }
    const space = trimmed.indexOf(' ')
    const key = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase()
    // A bare boolean key (`[core] fsmonitor`) has no value and means true. Last one wins.
    const value = space === -1 ? 'true' : trimmed.slice(space + 1).trim()
    if (isTuningKey(key)) {
      tuning[TUNING_KEYS[key]] = value
    }
  }
  return tuning
}

export function parseWorktreePaths(porcelain: string | null): string[] | null {
  if (porcelain === null) {
    return null
  }
  return porcelain
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim())
    .filter((path) => path.length > 0)
}

export type RepoGitInfo = {
  branch: string | null
  worktreePaths: string[] | null
  gitTuning: PodWorkspaceGitTuning
}

export async function readRepoGitInfo(
  repoPath: string,
  git: WorkspaceGitRunner
): Promise<RepoGitInfo> {
  const [head, worktrees, config] = await Promise.all([
    git(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath),
    git(['worktree', 'list', '--porcelain'], repoPath),
    git(['config', '--get-regexp', TUNING_KEY_PATTERN], repoPath)
  ])
  const branch = head?.trim() ?? ''
  return {
    branch: branch && branch !== 'HEAD' ? branch : null,
    worktreePaths: parseWorktreePaths(worktrees),
    gitTuning: parseGitTuning(config)
  }
}

export async function listTrackedRootFiles(
  repoPath: string,
  names: readonly string[],
  git: WorkspaceGitRunner
): Promise<string[]> {
  const stdout = await git(['ls-files', '--', ...names], repoPath)
  const tracked = new Set((stdout ?? '').split('\n').map((line) => line.trim()))
  return names.filter((name) => tracked.has(name))
}
