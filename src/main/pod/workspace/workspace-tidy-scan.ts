import { access } from 'node:fs/promises'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { mapWithConcurrency } from '../../../shared/map-with-concurrency'
import type {
  PodTidyBlocker,
  PodTidyReason,
  PodTidyScan,
  PodTidyWorktree
} from '../../../shared/pod-workspace-tidy-types'
import type { Repo } from '../../../shared/repo-types'
import { WORKTREE_ID_SEPARATOR } from '../../../shared/worktree/id'
import type { WorkspaceCleanupGitRoute } from '../../ipc/workspace-cleanup-git-route'
import {
  createWorkspaceCleanupBaseRefResolver,
  isWorkspaceCleanupBranchMerged
} from '../../ipc/workspace-cleanup-merged'
import type { WorkspaceGitExec } from './workspace-git-exec'
import type { WorkspaceJournal } from './workspace-journal'
import { fingerprintOf, type WorkspacePlanStore } from './workspace-plan-store'
import { findProcessesInside, type ProcessCwdReader } from './workspace-process-cwds'
import {
  BRANCH_TRACKING_ARGS,
  countStatusLines,
  isFsmonitorSocketPresent,
  parseBranchTracking,
  parseWorktreePorcelainZ,
  readWorktreeActivity,
  readWorktreeGitDir,
  type BranchTracking,
  type PorcelainWorktree
} from './workspace-tidy-git'
import { scanStrayFolders, type WorkspaceStrayStore } from './workspace-tidy-strays'

export const TIDY_STALE_MS = 30 * 24 * 60 * 60 * 1000
/** A watcher daemon idle this long is ~5 MiB held for nothing (75 daemons held 400 MiB). */
export const TIDY_IDLE_WATCHER_MS = 2 * 60 * 60 * 1000
const REPO_CONCURRENCY = 2
const WORKTREE_CONCURRENCY = 4
const LOCAL_ROUTE: WorkspaceCleanupGitRoute = { kind: 'local', hostId: LOCAL_EXECUTION_HOST_ID }

export type WorkspaceTidyScanDeps = {
  git: WorkspaceGitExec
  processes: ProcessCwdReader | null
  journal: WorkspaceJournal
  plans: WorkspacePlanStore
  store: WorkspaceStrayStore
  now?: () => number
}

type ScannedWorktree = Omit<PodTidyWorktree, 'processes' | 'fingerprint'> & { statusText: string }

/**
 * Orca's merged rule (#27020: ancestry, and a branch with a single reflog entry never counts),
 * plus Pod's: a branch restored from a Pod archive has one entry too, yet carried work.
 */
async function isMerged(
  git: WorkspaceGitExec,
  entry: PorcelainWorktree,
  isMain: boolean,
  base: string | null
): Promise<boolean> {
  if (!entry.branch || !base) {
    return false
  }
  const checkout = {
    path: entry.path,
    branch: entry.branch,
    isMainWorktree: isMain,
    prunable: false
  }
  if (await isWorkspaceCleanupBranchMerged(checkout, base, LOCAL_ROUTE)) {
    return true
  }
  const short = entry.branch.replace(/^refs\/heads\//, '')
  if (isMain || base === short || base.endsWith(`/${short}`)) {
    return false
  }
  const reflog = await git(['reflog', 'show', '-n', '2', '--format=%gs', entry.branch], entry.path)
  const lines = reflog.stdout.split('\n').filter(Boolean)
  if (lines.length !== 1 || !lines[0].includes('refs/pod/archive/')) {
    return false
  }
  return (await git(['merge-base', '--is-ancestor', 'HEAD', base], entry.path)).code === 0
}

async function scanWorktree(
  git: WorkspaceGitExec,
  repo: Repo,
  entry: PorcelainWorktree,
  tracking: Map<string, BranchTracking>,
  base: string | null,
  isMain: boolean,
  now: number
): Promise<ScannedWorktree> {
  const reasons: PodTidyReason[] = []
  const blockers: PodTidyBlocker[] = []
  const gitDir = entry.prunable ? null : await readWorktreeGitDir(entry.path)
  const [activity, watcher] = gitDir
    ? await Promise.all([readWorktreeActivity(gitDir), isFsmonitorSocketPresent(gitDir)])
    : [0, false]
  const branch = entry.branch ? tracking.get(entry.branch) : undefined
  let dirtyCount: number | null = null
  let statusText = ''
  if (isMain) {
    blockers.push('main-worktree')
  }
  if (entry.locked) {
    blockers.push('locked')
  }
  if (entry.prunable) {
    reasons.push('prunable')
  } else {
    const status = await git(
      // Rename detection reads blobs; a blobless clone would fetch them.
      [
        '--no-optional-locks',
        'status',
        '--porcelain=v1',
        '--untracked-files=normal',
        '--no-renames'
      ],
      entry.path
    )
    statusText = status.stdout
    dirtyCount = status.code === 0 ? countStatusLines(status.stdout) : null
    if (dirtyCount === null) {
      blockers.push('git-error')
    } else if (dirtyCount > 0) {
      blockers.push('dirty')
    }
    if (await isMerged(git, entry, isMain, base)) {
      reasons.push('merged')
    }
    if (branch?.gone) {
      reasons.push('upstream-gone')
    }
    if (activity > 0 && now - activity >= TIDY_STALE_MS) {
      reasons.push('stale')
    }
    if (watcher && now - activity >= TIDY_IDLE_WATCHER_MS) {
      reasons.push('idle-watcher')
    }
  }
  // Unpushed: ahead of a live upstream, or no upstream and not already in the base.
  const unpushed =
    branch && !branch.gone && branch.upstream
      ? (branch.ahead ?? 0) > 0
      : !reasons.includes('merged') && !isMain && entry.branch !== null
  if (unpushed && !entry.prunable) {
    blockers.push('unpushed')
  }
  return {
    repoId: repo.id,
    worktreeId: `${repo.id}${WORKTREE_ID_SEPARATOR}${entry.path}`,
    path: entry.path,
    branch: entry.branch,
    head: entry.head,
    isMain,
    reasons,
    blockers,
    lastActivityAt: activity,
    ahead: branch?.ahead ?? null,
    dirtyCount,
    fsmonitorRunning: watcher,
    statusText
  }
}

export async function scanRepoWorktrees(
  git: WorkspaceGitExec,
  repo: Repo,
  now: number
): Promise<{ worktrees: ScannedWorktree[]; registered: string[] }> {
  const resolveBase = createWorkspaceCleanupBaseRefResolver(repo, LOCAL_ROUTE)
  const [list, trackingOut, base] = await Promise.all([
    git(['worktree', 'list', '--porcelain', '-z'], repo.path),
    git(BRANCH_TRACKING_ARGS, repo.path),
    resolveBase({}).catch(() => null)
  ])
  if (list.code !== 0) {
    throw new Error(list.stderr.trim() || 'git worktree list failed')
  }
  const entries = parseWorktreePorcelainZ(list.stdout).filter((entry) => !entry.bare)
  const tracking = parseBranchTracking(trackingOut.stdout)
  const worktrees = await mapWithConcurrency(entries, WORKTREE_CONCURRENCY, (entry, index) =>
    scanWorktree(git, repo, entry, tracking, base, index === 0, now)
  )
  return { worktrees, registered: entries.map((entry) => entry.path) }
}

/** What an apply depends on: the commit, the branch, the exact status and who works inside. */
export function worktreeFingerprint(
  worktree: Omit<PodTidyWorktree, 'fingerprint'> & { statusText: string }
): string {
  return fingerprintOf([
    worktree.path,
    worktree.head,
    worktree.branch,
    worktree.statusText,
    [...worktree.blockers].sort(),
    worktree.processes.map((process) => process.pid).sort((a, b) => a - b)
  ])
}

async function present(path: string | null): Promise<boolean> {
  return (
    path !== null &&
    (await access(path).then(
      () => true,
      () => false
    ))
  )
}

export async function scanWorkspaceTidy(
  deps: WorkspaceTidyScanDeps,
  repos: readonly Repo[]
): Promise<PodTidyScan> {
  const now = (deps.now ?? Date.now)()
  const errors: PodTidyScan['errors'] = []
  const perRepo = await mapWithConcurrency(repos, REPO_CONCURRENCY, async (repo) => {
    try {
      return { repo, ...(await scanRepoWorktrees(deps.git, repo, now)) }
    } catch (error) {
      errors.push({
        repoId: repo.id,
        message: error instanceof Error ? error.message : String(error)
      })
      return { repo, worktrees: [], registered: [] }
    }
  })
  const scanned = perRepo.flatMap((entry) => entry.worktrees)
  const live = scanned
    .filter((entry) => !entry.reasons.includes('prunable'))
    .map((entry) => entry.path)
  const inside = deps.processes ? await findProcessesInside(deps.processes, live) : new Map()
  const fingerprints = new Map<string, string>()
  const worktrees: PodTidyWorktree[] = scanned.map(({ statusText, ...entry }) => {
    const processes = inside.get(entry.path) ?? []
    const blockers: PodTidyBlocker[] =
      processes.length > 0 ? [...entry.blockers, 'process-inside'] : entry.blockers
    const fingerprint = worktreeFingerprint({ ...entry, blockers, processes, statusText })
    fingerprints.set(entry.worktreeId, fingerprint)
    return { ...entry, processes, blockers, fingerprint }
  })
  const strayFolders = await scanStrayFolders(
    deps.store,
    repos,
    perRepo.flatMap((entry) => entry.registered),
    now
  )
  for (const folder of strayFolders) {
    fingerprints.set(`stray:${folder.path}`, folder.fingerprint)
  }
  const prunable = perRepo
    .map((entry) => ({
      repoId: entry.repo.id,
      paths: entry.worktrees.filter((w) => w.reasons.includes('prunable')).map((w) => w.path)
    }))
    .filter((entry) => entry.paths.length > 0)
  for (const entry of prunable) {
    fingerprints.set(`prune:${entry.repoId}`, fingerprintOf(entry.paths))
  }
  const journal = await deps.journal.read()
  const inScope = (entry: { repoId: string }): boolean =>
    repos.some((repo) => repo.id === entry.repoId)
  const archives = journal.archives.filter(inScope)
  const trashed = journal.trashed.filter(inScope)
  for (const archive of archives) {
    fingerprints.set(
      `archive:${archive.id}`,
      fingerprintOf([archive.id, await present(archive.trashedPath)])
    )
  }
  for (const item of trashed) {
    fingerprints.set(
      `trashed:${item.id}`,
      fingerprintOf([item.id, await present(item.trashedPath)])
    )
  }
  return {
    ...deps.plans.issue('tidy', fingerprints),
    scannedAt: now,
    worktrees,
    strayFolders,
    prunable,
    archives,
    trashed,
    adoptions: journal.adoptions.filter(inScope),
    errors
  }
}
