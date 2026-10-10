import { readdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { mapWithConcurrency } from '../../../shared/map-with-concurrency'
import type {
  PodTidyBlocker,
  PodTidyReason,
  PodTidyScan,
  PodTidyStrayFolder,
  PodTidyWorktree
} from '../../../shared/pod-workspace-tidy-types'
import type { Repo } from '../../../shared/repo-types'
import { WORKTREE_ID_SEPARATOR } from '../../../shared/worktree/id'
import type { WorkspaceGitExec } from './workspace-git-exec'
import type { WorkspaceJournal } from './workspace-journal'
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

export const TIDY_STALE_MS = 30 * 24 * 60 * 60 * 1000
/** A watcher daemon idle this long is ~5 MiB held for nothing (75 daemons held 400 MiB). */
export const TIDY_IDLE_WATCHER_MS = 2 * 60 * 60 * 1000
const REPO_CONCURRENCY = 2
const WORKTREE_CONCURRENCY = 4
const STRAY_MIN_AGE_MS = 24 * 60 * 60 * 1000
const MAX_STRAY_ENTRIES = 200

export type WorkspaceTidyScanDeps = {
  git: WorkspaceGitExec
  processes: ProcessCwdReader | null
  journal: WorkspaceJournal
  defaultBaseRef: (repo: Repo) => Promise<string | null>
  now?: () => number
}

type RepoFacts = {
  base: string | null
  tracking: Map<string, BranchTracking>
}

async function isMerged(
  git: WorkspaceGitExec,
  repo: Repo,
  entry: PorcelainWorktree,
  facts: RepoFacts
): Promise<boolean> {
  if (!entry.branch || !entry.head || !facts.base) {
    return false
  }
  // A branch is never "merged" into its own remote copy (`main` vs `origin/main`).
  const short = entry.branch.replace(/^refs\/heads\//, '')
  if (facts.base === short || facts.base.endsWith(`/${short}`)) {
    return false
  }
  const ancestor = await git(['merge-base', '--is-ancestor', entry.head, facts.base], repo.path)
  if (ancestor.code !== 0) {
    return false
  }
  // A branch created and never committed to also sits behind its base; its reflog says so.
  // One restored from a Pod archive was committed to before, so it still counts.
  const reflog = await git(['reflog', 'show', '-n', '2', '--format=%gs', entry.branch], repo.path)
  const lines = reflog.stdout.split('\n').filter(Boolean)
  return lines.length > 1 || (lines.length === 1 && lines[0].includes('refs/pod/archive/'))
}

async function scanWorktree(
  deps: WorkspaceTidyScanDeps,
  repo: Repo,
  entry: PorcelainWorktree,
  facts: RepoFacts,
  isMain: boolean,
  now: number
): Promise<Omit<PodTidyWorktree, 'processes'>> {
  const reasons: PodTidyReason[] = []
  const blockers: PodTidyBlocker[] = []
  const gitDir = entry.prunable ? null : await readWorktreeGitDir(entry.path)
  const [activity, watcher] = gitDir
    ? await Promise.all([readWorktreeActivity(gitDir), isFsmonitorSocketPresent(gitDir)])
    : [0, false]
  const tracking = entry.branch ? facts.tracking.get(entry.branch) : undefined
  let dirtyCount: number | null = null
  if (isMain) {
    blockers.push('main-worktree')
  }
  if (entry.locked) {
    blockers.push('locked')
  }
  if (entry.prunable) {
    reasons.push('prunable')
  } else {
    const status = await deps.git(
      ['--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=normal'],
      entry.path
    )
    dirtyCount = status.code === 0 ? countStatusLines(status.stdout) : null
    if (dirtyCount === null) {
      blockers.push('git-error')
    } else if (dirtyCount > 0) {
      blockers.push('dirty')
    }
    if (!isMain && (await isMerged(deps.git, repo, entry, facts))) {
      reasons.push('merged')
    }
    if (tracking?.gone) {
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
    tracking && !tracking.gone && tracking.upstream
      ? (tracking.ahead ?? 0) > 0
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
    ahead: tracking?.ahead ?? null,
    dirtyCount,
    fsmonitorRunning: watcher
  }
}

/** Pod's layout keeps linked worktrees in `<repo>.worktrees/`; anything there git does not name is stray. */
async function findStrayFolders(
  repo: Repo,
  registered: ReadonlySet<string>,
  now: number
): Promise<PodTidyStrayFolder[]> {
  const parent = join(dirname(repo.path), `${basename(repo.path)}.worktrees`)
  let names: string[]
  try {
    names = (await readdir(parent))
      .filter((name) => !name.startsWith('.'))
      .slice(0, MAX_STRAY_ENTRIES)
  } catch {
    return []
  }
  const out: PodTidyStrayFolder[] = []
  for (const name of names) {
    const path = join(parent, name)
    if (registered.has(path)) {
      continue
    }
    try {
      const info = await stat(path)
      // A folder with any `.git` may be a checkout git lost track of: leave it to the user.
      const hasGit = await stat(join(path, '.git')).then(
        () => true,
        () => false
      )
      if (info.isDirectory() && !hasGit && now - info.mtimeMs >= STRAY_MIN_AGE_MS) {
        out.push({ repoId: repo.id, path, modifiedAt: info.mtimeMs })
      }
    } catch {
      // Vanished between readdir and stat.
    }
  }
  return out
}

export async function scanRepoWorktrees(
  deps: WorkspaceTidyScanDeps,
  repo: Repo,
  now: number
): Promise<{
  worktrees: Omit<PodTidyWorktree, 'processes'>[]
  stray: PodTidyStrayFolder[]
  prunable: string[]
}> {
  const [list, trackingOut, base] = await Promise.all([
    deps.git(['worktree', 'list', '--porcelain', '-z'], repo.path),
    deps.git(BRANCH_TRACKING_ARGS, repo.path),
    deps.defaultBaseRef(repo)
  ])
  if (list.code !== 0) {
    throw new Error(list.stderr.trim() || 'git worktree list failed')
  }
  const entries = parseWorktreePorcelainZ(list.stdout).filter((entry) => !entry.bare)
  const facts: RepoFacts = { base, tracking: parseBranchTracking(trackingOut.stdout) }
  const worktrees = await mapWithConcurrency(entries, WORKTREE_CONCURRENCY, (entry, index) =>
    scanWorktree(deps, repo, entry, facts, index === 0, now)
  )
  const registered = new Set(entries.map((entry) => entry.path))
  return {
    worktrees,
    stray: await findStrayFolders(repo, registered, now),
    prunable: entries.filter((entry) => entry.prunable).map((entry) => entry.path)
  }
}

export async function scanWorkspaceTidy(
  deps: WorkspaceTidyScanDeps,
  repos: readonly Repo[]
): Promise<PodTidyScan> {
  const now = (deps.now ?? Date.now)()
  const errors: PodTidyScan['errors'] = []
  const perRepo = await mapWithConcurrency(repos, REPO_CONCURRENCY, async (repo) => {
    try {
      return { repo, ...(await scanRepoWorktrees(deps, repo, now)) }
    } catch (error) {
      errors.push({
        repoId: repo.id,
        message: error instanceof Error ? error.message : String(error)
      })
      return { repo, worktrees: [], stray: [], prunable: [] }
    }
  })
  const scanned = perRepo.flatMap((entry) => entry.worktrees)
  const live = scanned
    .filter((entry) => !entry.reasons.includes('prunable'))
    .map((entry) => entry.path)
  const inside = deps.processes ? await findProcessesInside(deps.processes, live) : new Map()
  const worktrees: PodTidyWorktree[] = scanned.map((entry) => {
    const processes = inside.get(entry.path) ?? []
    return {
      ...entry,
      processes,
      blockers: processes.length > 0 ? [...entry.blockers, 'process-inside'] : entry.blockers
    }
  })
  const journal = await deps.journal.read()
  const inScope = (entry: { repoId: string }): boolean =>
    repos.some((repo) => repo.id === entry.repoId)
  return {
    scannedAt: now,
    worktrees,
    strayFolders: perRepo.flatMap((entry) => entry.stray),
    prunable: perRepo
      .filter((entry) => entry.prunable.length > 0)
      .map((entry) => ({ repoId: entry.repo.id, names: entry.prunable })),
    archives: journal.archives.filter(inScope),
    adoptions: journal.adoptions.filter(inScope),
    errors
  }
}
