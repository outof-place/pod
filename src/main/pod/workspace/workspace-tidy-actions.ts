import { randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import { basename } from 'node:path'
import type {
  PodTidyAction,
  PodTidyArchive,
  PodTidyBlocker,
  PodTidyResult
} from '../../../shared/pod-workspace-tidy-types'
import type { Repo } from '../../../shared/repo-types'
import { getRepoIdFromWorktreeId, splitWorktreeId } from '../../../shared/worktree/id'
import type { WorkspaceGitExec } from './workspace-git-exec'
import { scanWorkspaceTidy, type WorkspaceTidyScanDeps } from './workspace-tidy-scan'

/** An archive must lose nothing git cannot give back: these stop it. */
const ARCHIVE_BLOCKERS: ReadonlySet<PodTidyBlocker> = new Set([
  'main-worktree',
  'locked',
  'dirty',
  'process-inside',
  'git-error'
])

export type WorkspaceTidyActionDeps = WorkspaceTidyScanDeps & {
  getRepo: (repoId: string) => Repo | undefined
  /** Orca's own removal: terminals, hooks, metadata and the folder. */
  removeWorktree: (worktreeId: string) => Promise<void>
  trash: (path: string) => Promise<void>
}

function archiveRefName(branch: string | null, path: string, now: number): string {
  const name = (branch?.replace(/^refs\/heads\//, '') ?? basename(path)).replace(
    /[^A-Za-z0-9._-]+/g,
    '-'
  )
  return `refs/pod/archive/${now}-${name.replace(/^[.-]+|[.-]+$/g, '') || 'worktree'}`
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false
  )
}

async function mustSucceed(result: Promise<{ code: number | null; stderr: string }>, what: string) {
  const settled = await result
  if (settled.code !== 0) {
    throw new Error(settled.stderr.trim() || `${what} failed`)
  }
}

export function createWorkspaceTidyActions(deps: WorkspaceTidyActionDeps) {
  const now = deps.now ?? Date.now
  const git: WorkspaceGitExec = deps.git

  const repoOrThrow = (repoId: string): Repo => {
    const repo = deps.getRepo(repoId)
    if (!repo) {
      throw new Error('Unknown repository')
    }
    return repo
  }

  /**
   * Orca's removal tears down its terminals and metadata too. A worktree it doesn't list yet (one
   * git just added, such as a restore its catalog hasn't caught up with) has none of those, so
   * git alone removes it; the archive already proved it clean.
   */
  const removeThroughRuntime = async (worktreeId: string, path: string, repoPath: string) => {
    try {
      await deps.removeWorktree(worktreeId)
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'selector_not_found') {
        throw error
      }
      await mustSucceed(git(['worktree', 'remove', path], repoPath), 'git worktree remove')
    }
  }

  /** Keeps the commits in `refs/pod/archive/…`, then lets Orca remove the worktree as usual. */
  const archive = async (worktreeId: string): Promise<PodTidyResult> => {
    const repo = repoOrThrow(getRepoIdFromWorktreeId(worktreeId))
    const path = splitWorktreeId(worktreeId)?.worktreePath
    // Re-proven here: the scan the user looked at may be minutes old.
    const scan = await scanWorkspaceTidy(deps, [repo])
    const entry = scan.worktrees.find((candidate) => candidate.path === path)
    if (!entry || !entry.head) {
      throw new Error('That worktree is gone')
    }
    const blocked = entry.blockers.filter((blocker) => ARCHIVE_BLOCKERS.has(blocker))
    if (blocked.length > 0) {
      throw new Error(`Not archived: ${blocked.join(', ')}`)
    }
    const at = now()
    const record: PodTidyArchive = {
      id: randomUUID(),
      repoId: repo.id,
      repoPath: repo.path,
      path: entry.path,
      branch: entry.branch,
      head: entry.head,
      ref: archiveRefName(entry.branch, entry.path, at),
      archivedAt: at
    }
    // The empty old value makes this create-only.
    await mustSucceed(git(['update-ref', record.ref, record.head, ''], repo.path), 'update-ref')
    await deps.journal.update((data) => void data.archives.push(record))
    try {
      await removeThroughRuntime(worktreeId, entry.path, repo.path)
    } catch (error) {
      await git(['update-ref', '-d', record.ref, record.head], repo.path)
      await deps.journal.update((data) => {
        data.archives = data.archives.filter((candidate) => candidate.id !== record.id)
      })
      throw error
    }
    return { ok: true, message: `Archived ${basename(entry.path)}`, archive: record }
  }

  const findArchive = async (archiveId: string): Promise<PodTidyArchive> => {
    const record = (await deps.journal.read()).archives.find((entry) => entry.id === archiveId)
    if (!record) {
      throw new Error('Unknown archive')
    }
    return record
  }

  const dropArchive = async (record: PodTidyArchive): Promise<void> => {
    await git(['update-ref', '-d', record.ref, record.head], record.repoPath)
    await deps.journal.update((data) => {
      data.archives = data.archives.filter((candidate) => candidate.id !== record.id)
    })
  }

  /** Checks the branch out again where it was; a branch that moved on gets a `-restored` twin. */
  const restore = async (archiveId: string): Promise<PodTidyResult> => {
    const record = await findArchive(archiveId)
    if (await exists(record.path)) {
      throw new Error('A folder already exists where the worktree was')
    }
    const branch = record.branch?.replace(/^refs\/heads\//, '') ?? null
    let args: string[]
    if (!branch) {
      args = ['worktree', 'add', '--detach', record.path, record.ref]
    } else {
      const tip = await git(
        ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
        record.repoPath
      )
      args =
        tip.code !== 0
          ? ['worktree', 'add', '-b', branch, record.path, record.ref]
          : tip.stdout.trim() === record.head
            ? ['worktree', 'add', record.path, branch]
            : ['worktree', 'add', '-b', `${branch}-restored`, record.path, record.ref]
    }
    await mustSucceed(git(args, record.repoPath, { timeoutMs: 120_000 }), 'git worktree add')
    await dropArchive(record)
    return { ok: true, message: `Restored ${basename(record.path)}` }
  }

  const prune = async (repoId: string): Promise<PodTidyResult> => {
    const repo = repoOrThrow(repoId)
    const result = await git(['worktree', 'prune', '--verbose'], repo.path)
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || 'git worktree prune failed')
    }
    // git reports each pruned entry on stderr: `Removing worktrees/<name>: <why>`.
    const pruned = `${result.stdout}\n${result.stderr}`
      .split('\n')
      .map((line) => /^Removing (?:worktrees\/)?([^:]+):/.exec(line.trim())?.[1])
      .filter((name): name is string => Boolean(name))
    return { ok: true, message: `Pruned ${pruned.length} registrations`, pruned }
  }

  const trashStray = async (repoId: string, path: string): Promise<PodTidyResult> => {
    const repo = repoOrThrow(repoId)
    const scan = await scanWorkspaceTidy(deps, [repo])
    if (!scan.strayFolders.some((folder) => folder.path === path)) {
      throw new Error('That folder is no longer a stray worktree folder')
    }
    await deps.trash(path)
    return { ok: true, message: `Moved ${basename(path)} to the Trash` }
  }

  const stopWatcher = async (worktreeId: string): Promise<PodTidyResult> => {
    const path = splitWorktreeId(worktreeId)?.worktreePath
    if (!path || !deps.getRepo(getRepoIdFromWorktreeId(worktreeId))) {
      throw new Error('Unknown worktree')
    }
    // The next git status starts it again; nothing to undo.
    await git(['fsmonitor--daemon', 'stop'], path)
    return { ok: true, message: `Stopped the file watcher in ${basename(path)}` }
  }

  const run = async (action: PodTidyAction): Promise<PodTidyResult> => {
    switch (action.kind) {
      case 'archive':
        return archive(action.worktreeId)
      case 'restore':
        return restore(action.archiveId)
      case 'forget': {
        const record = await findArchive(action.archiveId)
        await dropArchive(record)
        return { ok: true, message: `Forgot the archive of ${basename(record.path)}` }
      }
      case 'prune':
        return prune(action.repoId)
      case 'trash-stray':
        return trashStray(action.repoId, action.path)
      case 'stop-watcher':
        return stopWatcher(action.worktreeId)
    }
  }

  return { run }
}

export type WorkspaceTidyActions = ReturnType<typeof createWorkspaceTidyActions>
