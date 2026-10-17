import { randomUUID } from 'node:crypto'
import { lstat, mkdir, realpath, rename, stat, symlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type {
  PodAdoptBlocker,
  PodAdoptPlan,
  PodAdoptRecord,
  PodAdoptRelinkRecord
} from '../../../shared/pod-workspace-tidy-types'
import type { Repo } from '../../../shared/repo-types'
import {
  claudeProjectKey,
  createAdoptRelink,
  remapPath as remap,
  type AdoptMove,
  type AdoptRelinkInputs,
  type AdoptRelinkRuntime,
  type AdoptRelinkStore
} from './workspace-adopt-relink'
import { createWorkspaceAdoptUndo, listWorktreePaths, stopWatchers } from './workspace-adopt-undo'
import {
  POD_WORKSPACE_LOCAL_OWNER_DIR,
  parseCloneOwnerAndName
} from './workspace-clone-destination'
import type { WorkspaceGitExec } from './workspace-git-exec'
import type { WorkspaceJournal } from './workspace-journal'
import { fingerprintOf, WorkspacePlanError, type WorkspacePlanStore } from './workspace-plan-store'
import { findProcessesInside, type ProcessCwdReader } from './workspace-process-cwds'
import { isPathInsideWorkspaceRoot } from './workspace-root-path'
import { podWorktreesDirOf as worktreesDirOf } from './workspace-tidy-strays'

export { claudeProjectKey }

export type WorkspaceAdoptDeps = {
  git: WorkspaceGitExec
  journal: WorkspaceJournal
  plans: WorkspacePlanStore
  processes: ProcessCwdReader | null
  getRepo: (repoId: string) => Repo | undefined
  /** Pod's records that name the repo's paths; Move In re-keys them to the new place. */
  store: AdoptRelinkStore
  root: () => string
  home: string
  /** The profile's `terminal-history/`, whose folders are keyed by worktree id. */
  historyRoot: string
  now?: () => number
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

/** The folders a Move In renames, under each spelling Pod or git may know them by. */
function movesOf(repo: Repo, from: string, to: string, worktreesDir: string | null): AdoptMove[] {
  const moves: AdoptMove[] = [[from, to]]
  if (worktreesDir) {
    moves.push([worktreesDir, worktreesDirOf(to)])
  }
  if (repo.path !== from) {
    moves.push([repo.path, to])
    if (worktreesDir) {
      moves.push([worktreesDirOf(repo.path), worktreesDirOf(to)])
    }
  }
  return moves
}

export function createWorkspaceAdopt(deps: WorkspaceAdoptDeps) {
  const { git } = deps
  const claudeDir = (path: string) => join(deps.home, '.claude', 'projects', claudeProjectKey(path))
  const relink = createAdoptRelink({
    git,
    journal: deps.journal,
    store: deps.store,
    getRepo: deps.getRepo,
    home: deps.home,
    historyRoot: deps.historyRoot
  })

  const targetFor = async (repo: Repo): Promise<string> => {
    const url = await git(['remote', 'get-url', 'origin'], repo.path)
    const name = basename(repo.path)
    const parsed = url.code === 0 ? parseCloneOwnerAndName(url.stdout.trim()) : null
    // Same layout as a Pod clone; a repo without an owner goes where Pod's new projects go.
    return parsed
      ? join(deps.root(), ...parsed.owner, parsed.name)
      : join(deps.root(), POD_WORKSPACE_LOCAL_OWNER_DIR, name)
  }

  type Inspected = Omit<PodAdoptPlan, 'planId' | 'expiresAt'>

  const inspect = async (
    repoId: string,
    runtime: AdoptRelinkRuntime | null
  ): Promise<{ inspected: Inspected; inputs: AdoptRelinkInputs | null }> => {
    const repo = deps.getRepo(repoId)
    const blockers: PodAdoptBlocker[] = []
    if (!repo) {
      const relinkPlan = {
        worktrees: [],
        claudeProjectDirs: [],
        historyDirs: 0,
        configPaths: [],
        terminalsOpen: []
      }
      const inspected: Inspected = {
        repoId,
        from: '',
        to: '',
        blockers: ['not-a-repo'],
        processes: [],
        linkedWorktrees: [],
        worktreesDir: null,
        claudeProjectDir: null,
        relink: relinkPlan
      }
      return { inspected, inputs: null }
    }
    const from = await realpath(repo.path).catch(() => repo.path)
    const to = await targetFor(repo)
    if (isPathInsideWorkspaceRoot(from, deps.root())) {
      blockers.push('already-inside')
    }
    const siblings = (await pathExists(worktreesDirOf(from))) ? [worktreesDirOf(from)] : []
    if ((await pathExists(to)) || (siblings.length > 0 && (await pathExists(worktreesDirOf(to))))) {
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
    const folders = [from, ...siblings]
    const inside = deps.processes ? await findProcessesInside(deps.processes, folders) : new Map()
    const processes = folders.flatMap((folder) => inside.get(folder) ?? [])
    if (processes.length > 0) {
      blockers.push('process-inside')
    }
    const inputs: AdoptRelinkInputs = {
      repo,
      moves: movesOf(repo, from, to, siblings[0] ?? null),
      checkouts: worktrees,
      repoPathAfter: to
    }
    const relinkPlan = await relink.plan(inputs, runtime)
    // A live pane would be re-keyed under its running process; Close Terminals first.
    if (relinkPlan.terminalsOpen.length > 0) {
      blockers.push('terminals-open')
    }
    const claude = claudeDir(from)
    const inspected: Inspected = {
      repoId,
      from,
      to,
      blockers,
      processes,
      linkedWorktrees,
      worktreesDir: siblings[0] ?? null,
      claudeProjectDir: (await pathExists(claude)) ? claude : null,
      relink: relinkPlan
    }
    return { inspected, inputs }
  }

  const fingerprint = (plan: Inspected): string =>
    fingerprintOf([
      plan.from,
      plan.to,
      [...plan.blockers].sort(),
      plan.processes.map((process) => process.pid).sort((a, b) => a - b),
      plan.linkedWorktrees,
      plan.worktreesDir,
      plan.claudeProjectDir,
      plan.relink
    ])

  const plan = async (
    repoId: string,
    runtime: AdoptRelinkRuntime | null = null
  ): Promise<PodAdoptPlan> => {
    const { inspected } = await inspect(repoId, runtime)
    const fingerprints = new Map([[`adopt:${repoId}`, fingerprint(inspected)]])
    return { ...deps.plans.issue('adopt', fingerprints, repoId), ...inspected }
  }

  /**
   * Moves the repo, leaves a symlink where it was, lets git re-point its worktrees, then carries
   * Pod's records and Claude's folders to the new path. Processes inside keep running (their cwd
   * moves with the folder) only when the user ticked them; a live Pod terminal always refuses.
   */
  const apply = async (
    planId: string,
    acknowledged: readonly 'process-inside'[] = [],
    runtime: AdoptRelinkRuntime | null = null
  ): Promise<PodAdoptRecord> => {
    const repoId = deps.plans.subjectOf(planId, 'adopt')
    const { inspected: current, inputs } = await inspect(repoId, runtime)
    deps.plans.verify(planId, 'adopt', `adopt:${repoId}`, fingerprint(current))
    const refused = current.blockers.filter(
      (blocker) => !(blocker === 'process-inside' && acknowledged.includes(blocker))
    )
    if (refused.length > 0 || !inputs) {
      throw new WorkspacePlanError(`Not moved: ${refused.join(', ')}`)
    }
    deps.plans.consume(planId)
    const { from, to } = current
    const moves: AdoptMove[] = [[from, to]]
    if (current.worktreesDir) {
      moves.push([current.worktreesDir, worktreesDirOf(to)])
    }
    await stopWatchers(git, [from, ...current.linkedWorktrees])
    await mkdir(dirname(to), { recursive: true })
    for (const [old, next] of moves) {
      await rename(old, next)
      // Orca, shells and scripts that still name the old path keep working through it.
      await symlink(next, old)
    }
    await git(
      ['worktree', 'repair', ...current.linkedWorktrees.map((path) => remap(path, moves))],
      to
    )
    const relinked: PodAdoptRelinkRecord = {
      repoPath: inputs.repo.path,
      repoPathAfter: inputs.repo.path,
      worktreeIds: [],
      claudeProjectDirs: [],
      historyDirs: [],
      configPaths: []
    }
    const record: PodAdoptRecord = {
      id: randomUUID(),
      repoId,
      from,
      to,
      movedAt: (deps.now ?? Date.now)(),
      worktreesDirMoved: current.worktreesDir !== null,
      claudeProjectDirMoved: false,
      relink: relinked
    }
    try {
      await relink.apply(inputs, current.relink.configPaths, runtime, relinked)
    } finally {
      // Whatever got carried is recorded, so even a move that failed part way can be moved back.
      record.claudeProjectDirMoved = relinked.claudeProjectDirs.some(
        ([old]) => old === current.claudeProjectDir
      )
      await deps.journal.update((data) => void data.adoptions.push(record))
    }
    return record
  }

  const { planUndo, undo } = createWorkspaceAdoptUndo({
    git,
    journal: deps.journal,
    plans: deps.plans,
    processes: deps.processes,
    relink,
    claudeDir
  })

  return { plan, apply, planUndo, undo }
}

export type WorkspaceAdopt = ReturnType<typeof createWorkspaceAdopt>
