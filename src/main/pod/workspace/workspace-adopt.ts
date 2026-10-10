import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readlink, realpath, rename, stat, symlink, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type {
  PodAdoptBlocker,
  PodAdoptPlan,
  PodAdoptRecord,
  PodAdoptUndoPlan
} from '../../../shared/pod-workspace-tidy-types'
import type { Repo } from '../../../shared/repo-types'
import {
  POD_WORKSPACE_LOCAL_OWNER_DIR,
  parseCloneOwnerAndName
} from './workspace-clone-destination'
import type { WorkspaceGitExec } from './workspace-git-exec'
import type { WorkspaceJournal } from './workspace-journal'
import { fingerprintOf, WorkspacePlanError, type WorkspacePlanStore } from './workspace-plan-store'
import { findProcessesInside, type ProcessCwdReader } from './workspace-process-cwds'
import { isPathInsideWorkspaceRoot } from './workspace-root-path'
import { parseWorktreePorcelainZ } from './workspace-tidy-git'
import { podWorktreesDirOf as worktreesDirOf } from './workspace-tidy-strays'

export type WorkspaceAdoptDeps = {
  git: WorkspaceGitExec
  journal: WorkspaceJournal
  plans: WorkspacePlanStore
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

/** A path inside a moved folder, re-rooted at the folder's new place. */
function remap(path: string, moves: readonly (readonly [string, string])[]): string {
  for (const [from, to] of moves) {
    if (path === from || path.startsWith(`${from}/`)) {
      return to + path.slice(from.length)
    }
  }
  return path
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

  type Inspected = Omit<PodAdoptPlan, 'planId' | 'expiresAt'>

  const inspect = async (repoId: string): Promise<Inspected> => {
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
        worktreesDir: null,
        claudeProjectDir: null
      }
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
    const claude = claudeDir(from)
    return {
      repoId,
      from,
      to,
      blockers,
      processes,
      linkedWorktrees,
      worktreesDir: siblings[0] ?? null,
      claudeProjectDir: (await pathExists(claude)) ? claude : null
    }
  }

  const fingerprint = (plan: Inspected): string =>
    fingerprintOf([
      plan.from,
      plan.to,
      [...plan.blockers].sort(),
      plan.processes.map((process) => process.pid).sort((a, b) => a - b),
      plan.linkedWorktrees,
      plan.worktreesDir,
      plan.claudeProjectDir
    ])

  const plan = async (repoId: string): Promise<PodAdoptPlan> => {
    const inspected = await inspect(repoId)
    const fingerprints = new Map([[`adopt:${repoId}`, fingerprint(inspected)]])
    return { ...deps.plans.issue('adopt', fingerprints, repoId), ...inspected }
  }

  const stopWatchers = (paths: readonly string[]) =>
    Promise.all(paths.map((path) => git(['fsmonitor--daemon', 'stop'], path)))

  /**
   * Moves the repo, leaves a symlink where it was, and lets git re-point its worktrees.
   * Processes inside keep running (their cwd moves with the folder) only when the user ticked them.
   */
  const apply = async (
    planId: string,
    acknowledged: readonly 'process-inside'[] = []
  ): Promise<PodAdoptRecord> => {
    const repoId = deps.plans.subjectOf(planId, 'adopt')
    const current = await inspect(repoId)
    deps.plans.verify(planId, 'adopt', `adopt:${repoId}`, fingerprint(current))
    const refused = current.blockers.filter(
      (blocker) => !(blocker === 'process-inside' && acknowledged.includes(blocker))
    )
    if (refused.length > 0) {
      throw new WorkspacePlanError(`Not moved: ${refused.join(', ')}`)
    }
    deps.plans.consume(planId)
    const { from, to } = current
    const moves: [string, string][] = [[from, to]]
    if (current.worktreesDir) {
      moves.push([current.worktreesDir, worktreesDirOf(to)])
    }
    await stopWatchers([from, ...current.linkedWorktrees])
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
      worktreesDirMoved: current.worktreesDir !== null,
      claudeProjectDirMoved
    }
    await deps.journal.update((data) => void data.adoptions.push(record))
    return record
  }

  const recordOf = async (recordId: string): Promise<PodAdoptRecord> => {
    const record = (await deps.journal.read()).adoptions.find((entry) => entry.id === recordId)
    if (!record) {
      throw new WorkspacePlanError('That move was already undone.')
    }
    return record
  }

  const backMoves = (record: PodAdoptRecord): [string, string][] => {
    const moves: [string, string][] = [[record.to, record.from]]
    if (record.worktreesDirMoved) {
      moves.push([worktreesDirOf(record.to), worktreesDirOf(record.from)])
    }
    return moves
  }

  const inspectUndo = async (
    record: PodAdoptRecord
  ): Promise<Omit<PodAdoptUndoPlan, 'planId' | 'expiresAt'>> => {
    const blockers: PodAdoptUndoPlan['blockers'] = []
    if ((await readlink(record.from).catch(() => null)) !== record.to) {
      blockers.push('link-changed')
    }
    const folders = backMoves(record).map(([moved]) => moved)
    const inside = deps.processes ? await findProcessesInside(deps.processes, folders) : new Map()
    const processes = folders.flatMap((folder) => inside.get(folder) ?? [])
    if (processes.length > 0) {
      blockers.push('process-inside')
    }
    return { record, blockers, processes }
  }

  const undoFingerprint = (plan: Omit<PodAdoptUndoPlan, 'planId' | 'expiresAt'>): string =>
    fingerprintOf([plan.record, plan.blockers, plan.processes.map((process) => process.pid)])

  const planUndo = async (recordId: string): Promise<PodAdoptUndoPlan> => {
    const inspected = await inspectUndo(await recordOf(recordId))
    const fingerprints = new Map([[`adopt-undo:${recordId}`, undoFingerprint(inspected)]])
    return { ...deps.plans.issue('adopt-undo', fingerprints, recordId), ...inspected }
  }

  /** Always refused with a process inside: moving a folder back under a running agent is not undo. */
  const undo = async (planId: string): Promise<PodAdoptRecord> => {
    const recordId = deps.plans.subjectOf(planId, 'adopt-undo')
    const current = await inspectUndo(await recordOf(recordId))
    deps.plans.verify(planId, 'adopt-undo', `adopt-undo:${recordId}`, undoFingerprint(current))
    if (current.blockers.length > 0) {
      throw new WorkspacePlanError(`Not moved back: ${current.blockers.join(', ')}`)
    }
    deps.plans.consume(planId)
    const { record } = current
    const moves = backMoves(record)
    const worktrees = await listWorktreePaths(git, record.to)
    await stopWatchers(worktrees)
    for (const [moved, original] of moves) {
      // Only Pod's own link is replaced; anything else at the old path stays.
      if ((await readlink(original).catch(() => null)) === moved) {
        await unlink(original)
        await rename(moved, original)
      }
    }
    const linked = worktrees.filter((path) => path !== record.to)
    await git(['worktree', 'repair', ...linked.map((path) => remap(path, moves))], record.from)
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

  return { plan, apply, planUndo, undo }
}

export type WorkspaceAdopt = ReturnType<typeof createWorkspaceAdopt>
