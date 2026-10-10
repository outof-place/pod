import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readlink, realpath, rename, stat, symlink, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type {
  PodAdoptBlocker,
  PodAdoptPlan,
  PodAdoptRecord
} from '../../../shared/pod-workspace-tidy-types'
import type { Repo } from '../../../shared/repo-types'
import {
  POD_WORKSPACE_LOCAL_OWNER_DIR,
  parseCloneOwnerAndName
} from './workspace-clone-destination'
import type { WorkspaceGitExec } from './workspace-git-exec'
import type { WorkspaceJournal } from './workspace-journal'
import { findProcessesInside, type ProcessCwdReader } from './workspace-process-cwds'
import { isPathInsideWorkspaceRoot } from './workspace-root-path'
import { parseWorktreePorcelainZ } from './workspace-tidy-git'

export type WorkspaceAdoptDeps = {
  git: WorkspaceGitExec
  journal: WorkspaceJournal
  processes: ProcessCwdReader | null
  getRepo: (repoId: string) => Repo | undefined
  root: () => string
  home: string
  now?: () => number
}

/** Claude Code keys a project's history by its cwd with every non-alphanumeric as `-`. */
export function claudeProjectKey(path: string): string {
  return path.replace(/[^A-Za-z0-9]/g, '-')
}

async function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false
  )
}

async function nearestExisting(path: string): Promise<string> {
  let current = path
  while (!(await pathExists(current)) && dirname(current) !== current) {
    current = dirname(current)
  }
  return current
}

async function listWorktreePaths(git: WorkspaceGitExec, repoPath: string): Promise<string[]> {
  const list = await git(['worktree', 'list', '--porcelain', '-z'], repoPath)
  return list.code === 0 ? parseWorktreePorcelainZ(list.stdout).map((entry) => entry.path) : []
}

export function createWorkspaceAdopt(deps: WorkspaceAdoptDeps) {
  const { git } = deps
  const claudeDir = (path: string) => join(deps.home, '.claude', 'projects', claudeProjectKey(path))

  const targetFor = async (repo: Repo): Promise<string> => {
    const url = await git(['remote', 'get-url', 'origin'], repo.path)
    const name = basename(repo.path)
    const parsed = url.code === 0 ? parseCloneOwnerAndName(url.stdout.trim()) : null
    // Same layout as a Pod clone; a repo without an owner goes where Pod's new projects go.
    return parsed
      ? join(deps.root(), ...parsed.owner, parsed.name)
      : join(deps.root(), POD_WORKSPACE_LOCAL_OWNER_DIR, name)
  }

  const plan = async (repoId: string): Promise<PodAdoptPlan> => {
    const repo = deps.getRepo(repoId)
    const blockers: PodAdoptBlocker[] = []
    if (!repo) {
      return {
        repoId,
        from: '',
        to: '',
        blockers: ['not-a-repo'],
        processes: [],
        linkedWorktrees: [],
        claudeProjectDir: null
      }
    }
    const from = await realpath(repo.path).catch(() => repo.path)
    const to = await targetFor(repo)
    if (isPathInsideWorkspaceRoot(from, deps.root())) {
      blockers.push('already-inside')
    }
    if (await pathExists(to)) {
      blockers.push('target-exists')
    }
    const [source, target] = await Promise.all([
      stat(from),
      stat(await nearestExisting(dirname(to)))
    ])
    // rename(2) only within a volume; a copy of a live repo is not a move Pod can undo atomically.
    if (source.dev !== target.dev) {
      blockers.push('other-volume')
    }
    const worktrees = await listWorktreePaths(git, from)
    const linkedWorktrees = worktrees.filter((path) => path !== from && path !== repo.path)
    const inside = deps.processes ? await findProcessesInside(deps.processes, [from]) : new Map()
    const processes = inside.get(from) ?? []
    if (processes.length > 0) {
      blockers.push('process-inside')
    }
    const claude = claudeDir(from)
    return {
      repoId,
      from,
      to,
      blockers,
      processes,
      linkedWorktrees,
      claudeProjectDir: (await pathExists(claude)) ? claude : null
    }
  }

  const stopWatchers = (paths: readonly string[]) =>
    Promise.all(paths.map((path) => git(['fsmonitor--daemon', 'stop'], path)))

  /** Moves the repo, leaves a symlink where it was, and lets git re-point its worktrees. */
  const apply = async (repoId: string): Promise<PodAdoptRecord> => {
    const current = await plan(repoId)
    if (current.blockers.length > 0) {
      throw new Error(`Not moved: ${current.blockers.join(', ')}`)
    }
    const { from, to } = current
    const repo = deps.getRepo(repoId)
    await stopWatchers([from, ...current.linkedWorktrees])
    await mkdir(dirname(to), { recursive: true })
    await rename(from, to)
    // Orca, shells and scripts that still name the old path keep working through it.
    await symlink(to, from)
    if (repo && repo.path !== from && !(await pathExists(repo.path))) {
      await symlink(to, repo.path)
    }
    const moved = current.linkedWorktrees.map((path) =>
      path.startsWith(`${from}/`) ? join(to, path.slice(from.length + 1)) : path
    )
    await git(['worktree', 'repair', ...moved], to)
    let claudeProjectDirMoved = false
    if (current.claudeProjectDir && !(await pathExists(claudeDir(to)))) {
      await rename(current.claudeProjectDir, claudeDir(to))
      // A running session keeps writing under the old key; the link lands that in the new dir.
      await symlink(basename(claudeDir(to)), current.claudeProjectDir)
      claudeProjectDirMoved = true
    }
    const record: PodAdoptRecord = {
      id: randomUUID(),
      repoId,
      from,
      to,
      movedAt: (deps.now ?? Date.now)(),
      claudeProjectDirMoved
    }
    await deps.journal.update((data) => void data.adoptions.push(record))
    return record
  }

  const undo = async (recordId: string): Promise<PodAdoptRecord> => {
    const record = (await deps.journal.read()).adoptions.find((entry) => entry.id === recordId)
    if (!record) {
      throw new Error('Unknown move')
    }
    const link = await readlink(record.from).catch(() => null)
    if (link !== record.to) {
      throw new Error('The old path is no longer Pod’s link to the repository')
    }
    const inside = deps.processes
      ? await findProcessesInside(deps.processes, [record.to])
      : new Map()
    if ((inside.get(record.to) ?? []).length > 0) {
      throw new Error('Not moved back: processes are running inside the repository')
    }
    const worktrees = await listWorktreePaths(git, record.to)
    await stopWatchers(worktrees)
    await unlink(record.from)
    await rename(record.to, record.from)
    const back = worktrees
      .filter((path) => path !== record.to)
      .map((path) =>
        path.startsWith(`${record.to}/`)
          ? join(record.from, path.slice(record.to.length + 1))
          : path
      )
    await git(['worktree', 'repair', ...back], record.from)
    const oldClaude = claudeDir(record.from)
    if (
      record.claudeProjectDirMoved &&
      (await readlink(oldClaude).catch(() => null)) === basename(claudeDir(record.to))
    ) {
      await unlink(oldClaude)
      await rename(claudeDir(record.to), oldClaude)
    }
    await deps.journal.update((data) => {
      data.adoptions = data.adoptions.filter((entry) => entry.id !== recordId)
    })
    return record
  }

  return { plan, apply, undo }
}

export type WorkspaceAdopt = ReturnType<typeof createWorkspaceAdopt>
