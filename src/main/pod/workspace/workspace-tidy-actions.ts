import { randomUUID } from 'node:crypto'
import { access, rename, rmdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  POD_SOFT_BLOCKERS,
  type PodSoftBlocker,
  type PodTidyAction,
  type PodTidyArchive,
  type PodTidyResult,
  type PodTidyWorktree
} from '../../../shared/pod-workspace-tidy-types'
import type { Repo } from '../../../shared/repo-types'
import { getRepoIdFromWorktreeId, splitWorktreeId } from '../../../shared/worktree/id'
import { createWorkspacePlanStore, fingerprintOf } from './workspace-plan-store'
import type { WorkspaceTrash } from './workspace-trash'
import { scanWorkspaceTidy, type WorkspaceTidyScanDeps } from './workspace-tidy-scan'

export type WorkspaceTidyActionDeps = WorkspaceTidyScanDeps & {
  getRepo: (repoId: string) => Repo | undefined
  /** Orca's own removal: terminals, hooks, metadata, the registration and the branch. */
  removeWorktree: (worktreeId: string) => Promise<void>
  trash: WorkspaceTrash
}

export type WorkspaceTidyRequest = {
  planId: string
  action: PodTidyAction
  acknowledged?: readonly PodSoftBlocker[]
}

function archiveRefName(branch: string | null, path: string, now: number): string {
  const name = (branch?.replace(/^refs\/heads\//, '') ?? basename(path)).replace(
    /[^A-Za-z0-9._-]+/g,
    '-'
  )
  return `refs/pod/archive/${now}-${name.replace(/^[.-]+|[.-]+$/g, '') || 'worktree'}`
}

async function exists(path: string | null): Promise<boolean> {
  return (
    path !== null &&
    (await access(path).then(
      () => true,
      () => false
    ))
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
  const { git, plans, journal } = deps

  const repoOrThrow = (repoId: string): Repo => {
    const repo = deps.getRepo(repoId)
    if (!repo) {
      throw new Error('Unknown repository')
    }
    return repo
  }

  /** A fresh scan of the one repo, checked against what the plan showed the user. */
  const rescan = async (planId: string, repo: Repo, target: string) => {
    // A rescan's own plan goes to a throwaway store: nobody holds it.
    const scan = await scanWorkspaceTidy({ ...deps, plans: createWorkspacePlanStore() }, [repo])
    const fingerprintFor = (key: string): string | undefined =>
      scan.worktrees.find((entry) => entry.worktreeId === key)?.fingerprint ??
      scan.strayFolders.find((entry) => `stray:${entry.path}` === key)?.fingerprint
    plans.verify(planId, 'tidy', target, fingerprintFor(target) ?? 'gone')
    return scan
  }

  const requireAcknowledged = (entry: PodTidyWorktree, acknowledged: readonly PodSoftBlocker[]) => {
    const hard = entry.blockers.filter(
      (blocker) => !POD_SOFT_BLOCKERS.some((soft) => soft === blocker)
    )
    if (hard.length > 0 || entry.reasons.includes('prunable')) {
      throw new Error(`Not archived: ${hard.join(', ') || 'its folder is gone (prune it instead)'}`)
    }
    const unticked = entry.blockers.filter(
      (blocker) =>
        POD_SOFT_BLOCKERS.some((soft) => soft === blocker) &&
        !acknowledged.some((ok) => ok === blocker)
    )
    if (unticked.length > 0) {
      throw new Error(`Needs your OK first: ${unticked.join(', ')}`)
    }
  }

  /** Keeps the commits in a ref and the folder in the Trash; then Orca drops the worktree. */
  const archive = async (
    request: WorkspaceTidyRequest,
    worktreeId: string
  ): Promise<PodTidyResult> => {
    const repo = repoOrThrow(getRepoIdFromWorktreeId(worktreeId))
    const scan = await rescan(request.planId, repo, worktreeId)
    const entry = scan.worktrees.find((candidate) => candidate.worktreeId === worktreeId)
    if (!entry?.head) {
      throw new Error('That worktree is gone')
    }
    requireAcknowledged(entry, request.acknowledged ?? [])
    const at = now()
    const record: PodTidyArchive = {
      id: randomUUID(),
      repoId: repo.id,
      repoPath: repo.path,
      path: entry.path,
      branch: entry.branch,
      head: entry.head,
      ref: archiveRefName(entry.branch, entry.path, at),
      trashedPath: null,
      archivedAt: at
    }
    // The empty old value makes this create-only.
    await mustSucceed(git(['update-ref', record.ref, record.head, ''], repo.path), 'update-ref')
    record.trashedPath = await deps.trash.move(entry.path)
    await journal.update((data) => void data.archives.push(record))
    try {
      await removeRegistration(worktreeId, entry.path, repo.path)
    } catch (error) {
      if (record.trashedPath) {
        await deps.trash.putBack(record.trashedPath, entry.path)
      }
      await git(['update-ref', '-d', record.ref, record.head], repo.path)
      await journal.update((data) => {
        data.archives = data.archives.filter((candidate) => candidate.id !== record.id)
      })
      throw error
    }
    return {
      ok: true,
      message: `Archived ${basename(entry.path)}: its folder is in the Trash`,
      undo: { kind: 'restore', archiveId: record.id }
    }
  }

  /**
   * The folder is already in the Trash, so git only drops the registration. Orca's removal also
   * stops its terminals and forgets its metadata; a worktree it doesn't list yet (one git just
   * added) has neither, and git alone removes it.
   */
  const removeRegistration = async (worktreeId: string, path: string, repoPath: string) => {
    try {
      await deps.removeWorktree(worktreeId)
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'selector_not_found') {
        throw error
      }
      await mustSucceed(
        git(['worktree', 'remove', '--force', path], repoPath),
        'git worktree remove'
      )
    }
  }

  const findArchive = async (archiveId: string): Promise<PodTidyArchive> => {
    const record = (await journal.read()).archives.find((entry) => entry.id === archiveId)
    if (!record) {
      throw new Error('Unknown archive')
    }
    return record
  }

  const verifyRecord = async (
    planId: string,
    key: string,
    id: string,
    trashedPath: string | null
  ) => plans.verify(planId, 'tidy', key, fingerprintOf([id, await exists(trashedPath)]))

  const dropArchive = async (record: PodTidyArchive): Promise<void> => {
    await git(['update-ref', '-d', record.ref, record.head], record.repoPath)
    await journal.update((data) => {
      data.archives = data.archives.filter((candidate) => candidate.id !== record.id)
    })
  }

  /** The branch where it was, with the Trash's copy of the folder when it's still there. */
  const restore = async (
    request: WorkspaceTidyRequest,
    archiveId: string
  ): Promise<PodTidyResult> => {
    const record = await findArchive(archiveId)
    await verifyRecord(request.planId, `archive:${archiveId}`, record.id, record.trashedPath)
    if (await exists(record.path)) {
      throw new Error('A folder already exists where the worktree was')
    }
    const fromTrash = await exists(record.trashedPath)
    const branch = record.branch?.replace(/^refs\/heads\//, '') ?? null
    const checkout = fromTrash ? ['--no-checkout'] : []
    let target: string[]
    if (!branch) {
      target = ['--detach', record.path, record.ref]
    } else {
      const tip = await git(
        ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
        record.repoPath
      )
      target =
        tip.code !== 0
          ? ['-b', branch, record.path, record.ref]
          : tip.stdout.trim() === record.head
            ? [record.path, branch]
            : ['-b', `${branch}-restored`, record.path, record.ref]
    }
    await mustSucceed(
      git(['worktree', 'add', ...checkout, ...target], record.repoPath, {
        timeoutMs: 120_000,
        lazyFetch: true
      }),
      'git worktree add'
    )
    if (fromTrash && record.trashedPath) {
      // The trashed folder itself comes back, so nothing is left in the Trash: it takes the new
      // `.git` link, the checkout git just made (now empty) gives way, and the index is rebuilt
      // from HEAD, so edits that were uncommitted show as uncommitted again.
      await rename(join(record.path, '.git'), join(record.trashedPath, '.git'))
      await rmdir(record.path)
      await rename(record.trashedPath, record.path)
      await mustSucceed(
        git(['reset', '-q'], record.path, { timeoutMs: 120_000, lazyFetch: true }),
        'git reset'
      )
    }
    await dropArchive(record)
    return { ok: true, message: `Restored ${basename(record.path)}` }
  }

  const prune = async (request: WorkspaceTidyRequest, repoId: string): Promise<PodTidyResult> => {
    const repo = repoOrThrow(repoId)
    const scan = await scanWorkspaceTidy({ ...deps, plans: createWorkspacePlanStore() }, [repo])
    const paths = scan.worktrees.filter((w) => w.reasons.includes('prunable')).map((w) => w.path)
    plans.verify(request.planId, 'tidy', `prune:${repoId}`, fingerprintOf(paths))
    // Only registrations whose folder is gone: git's own admin files, no user data.
    const result = await git(['worktree', 'prune', '--verbose'], repo.path)
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || 'git worktree prune failed')
    }
    const pruned = `${result.stdout}\n${result.stderr}`
      .split('\n')
      .map((line) => /^Removing (?:worktrees\/)?([^:]+):/.exec(line.trim())?.[1])
      .filter((name): name is string => Boolean(name))
    return { ok: true, message: `Pruned ${pruned.length} registrations`, pruned }
  }

  const trashStray = async (request: WorkspaceTidyRequest, repoId: string, path: string) => {
    const repo = repoOrThrow(repoId)
    await rescan(request.planId, repo, `stray:${path}`)
    const trashedPath = await deps.trash.move(path)
    const id = randomUUID()
    if (trashedPath) {
      await journal.update(
        (data) => void data.trashed.push({ id, repoId, path, trashedPath, trashedAt: now() })
      )
    }
    return {
      ok: true,
      message: `Moved ${basename(path)} to the Trash`,
      ...(trashedPath ? { undo: { kind: 'put-back' as const, trashedId: id } } : {})
    }
  }

  const putBack = async (
    request: WorkspaceTidyRequest,
    trashedId: string
  ): Promise<PodTidyResult> => {
    const item = (await journal.read()).trashed.find((entry) => entry.id === trashedId)
    if (!item) {
      throw new Error('Unknown item')
    }
    await verifyRecord(request.planId, `trashed:${trashedId}`, item.id, item.trashedPath)
    await deps.trash.putBack(item.trashedPath, item.path)
    await journal.update((data) => {
      data.trashed = data.trashed.filter((entry) => entry.id !== trashedId)
    })
    return { ok: true, message: `Put ${basename(item.path)} back` }
  }

  const stopWatcher = async (request: WorkspaceTidyRequest, worktreeId: string) => {
    const path = splitWorktreeId(worktreeId)?.worktreePath
    const repo = repoOrThrow(getRepoIdFromWorktreeId(worktreeId))
    await rescan(request.planId, repo, worktreeId)
    // The next git status starts it again; nothing to undo.
    await git(['fsmonitor--daemon', 'stop'], path ?? repo.path)
    return { ok: true, message: `Stopped the file watcher in ${basename(path ?? repo.path)}` }
  }

  const run = async (request: WorkspaceTidyRequest): Promise<PodTidyResult> => {
    const { action } = request
    switch (action.kind) {
      case 'archive':
        return archive(request, action.worktreeId)
      case 'restore':
        return restore(request, action.archiveId)
      case 'forget': {
        const record = await findArchive(action.archiveId)
        await verifyRecord(request.planId, `archive:${record.id}`, record.id, record.trashedPath)
        await dropArchive(record)
        return {
          ok: true,
          message: `Forgot the archive of ${basename(record.path)}; its folder stays in the Trash`
        }
      }
      case 'prune':
        return prune(request, action.repoId)
      case 'trash-stray':
        return trashStray(request, action.repoId, action.path)
      case 'put-back':
        return putBack(request, action.trashedId)
      case 'stop-watcher':
        return stopWatcher(request, action.worktreeId)
    }
  }

  return { run }
}

export type WorkspaceTidyActions = ReturnType<typeof createWorkspaceTidyActions>
