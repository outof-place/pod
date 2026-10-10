import { readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'

export type PorcelainWorktree = {
  path: string
  head: string | null
  /** `refs/heads/x`; null when detached. */
  branch: string | null
  bare: boolean
  locked: boolean
  prunable: boolean
}

/** `git worktree list --porcelain -z`: attribute fields NUL-terminated, records end with an empty field. */
export function parseWorktreePorcelainZ(stdout: string): PorcelainWorktree[] {
  const out: PorcelainWorktree[] = []
  let current: PorcelainWorktree | null = null
  for (const field of stdout.split('\0')) {
    if (field === '') {
      if (current) {
        out.push(current)
      }
      current = null
      continue
    }
    const space = field.indexOf(' ')
    const name = space === -1 ? field : field.slice(0, space)
    const value = space === -1 ? '' : field.slice(space + 1)
    if (name === 'worktree') {
      current = {
        path: value,
        head: null,
        branch: null,
        bare: false,
        locked: false,
        prunable: false
      }
    } else if (current) {
      if (name === 'HEAD') {
        current.head = value
      } else if (name === 'branch') {
        current.branch = value
      } else if (name === 'bare') {
        current.bare = true
      } else if (name === 'locked') {
        current.locked = true
      } else if (name === 'prunable') {
        current.prunable = true
      }
    }
  }
  if (current) {
    out.push(current)
  }
  return out
}

export type BranchTracking = { upstream: string | null; gone: boolean; ahead: number | null }

// `%(upstream:track,nobracket)` prints `gone`, `ahead 2`, `behind 1`, `ahead 2, behind 1` or nothing.
export function parseBranchTracking(stdout: string): Map<string, BranchTracking> {
  const out = new Map<string, BranchTracking>()
  for (const line of stdout.split('\n')) {
    const [ref, upstream, track] = line.split('\0')
    if (!ref) {
      continue
    }
    const ahead = /ahead (\d+)/.exec(track ?? '')
    out.set(ref, {
      upstream: upstream || null,
      gone: (track ?? '').trim() === 'gone',
      ahead: upstream ? (ahead ? Number(ahead[1]) : 0) : null
    })
  }
  return out
}

export const BRANCH_TRACKING_ARGS = [
  'for-each-ref',
  '--format=%(refname)%00%(upstream:short)%00%(upstream:track,nobracket)',
  'refs/heads'
]

/** The worktree's admin dir from its `.git` file; the main worktree's is `.git` itself. */
export async function readWorktreeGitDir(worktreePath: string): Promise<string | null> {
  const dotGit = join(worktreePath, '.git')
  try {
    const info = await stat(dotGit)
    if (info.isDirectory()) {
      return dotGit
    }
    const match = /^gitdir:\s*(.+)$/m.exec(await readFile(dotGit, 'utf8'))
    if (!match) {
      return null
    }
    const value = match[1].trim()
    return isAbsolute(value) ? value : join(dirname(dotGit), value)
  } catch {
    return null
  }
}

async function mtime(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return 0
  }
}

/** Newest of what git touches on any use of the checkout: index, HEAD and the HEAD reflog. */
export async function readWorktreeActivity(gitDir: string): Promise<number> {
  const times = await Promise.all(
    ['index', 'HEAD', join('logs', 'HEAD')].map((name) => mtime(join(gitDir, name)))
  )
  return Math.max(0, ...times)
}

/** The daemon's socket exists while it runs (and briefly after a crash). */
export async function isFsmonitorSocketPresent(gitDir: string): Promise<boolean> {
  try {
    return (await stat(join(gitDir, 'fsmonitor--daemon.ipc'))).isSocket()
  } catch {
    return false
  }
}

/** Lines of `git status --porcelain=v1`, untracked included: what a removal would lose. */
export function countStatusLines(stdout: string): number {
  return stdout.split('\n').filter((line) => line.length > 0).length
}
