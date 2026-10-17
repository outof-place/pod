import { randomUUID } from 'node:crypto'
import { mkdir, realpath, rename, stat, symlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type {
  PodAdoptBlocker,
  PodAdoptPlan,
  PodAdoptRecord,
  PodAdoptRelinkRecord,
  PodAdoptSoftBlocker
} from '../../../shared/pod-workspace-tidy-types'
import type { Repo } from '../../../shared/repo-types'
import type { PodOrbstackWorktreeKeys } from '../orbstack/pod-orbstack-worktree-keys'
import { adoptWarnings, findOpenFilesInside } from './workspace-adopt-checks'
import {
  claudeProjectKey,
  movesOf,
  nearestExisting,
  pathExists,
  remapPath as remap,
  saveAdoptRecord,
  type AdoptMove
} from './workspace-adopt-paths'
import {
  createAdoptRelink,
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
import { isPathInsideRoot, isPathInsideWorkspaceRoot } from './workspace-root-path'
import { podWorktreesDirOf as worktreesDirOf } from './workspace-tidy-strays'

export { claudeProjectKey }

function isSoftBlocker(blocker: PodAdoptBlocker): blocker is PodAdoptSoftBlocker {
  return blocker === 'process-inside' || blocker === 'files-open'
}

export type WorkspaceAdoptDeps = {
  git: WorkspaceGitExec
  journal: WorkspaceJournal
  plans: WorkspacePlanStore
  processes: ProcessCwdReader | null
  getRepo: (repoId: string) => Repo | undefined
  /** Every project Pod knows, for the ones nested inside a folder that would move. */
  allRepos: () => readonly Repo[]
  /** Pod's records that name the repo's paths; Move In re-keys them to the new place. */
  store: AdoptRelinkStore
  orbstack?: () => PodOrbstackWorktreeKeys | null
  root: () => string
  home: string
  /** The profile's `terminal-history/`, whose folders are keyed by worktree id. */
  historyRoot: string
  now?: () => number
}

const NO_RELINK = {
  worktrees: [],
  claudeProjectDirs: [],
  historyDirs: 0,
  configPaths: [],
  terminalsOpen: [],
  orbstackMachines: [],
  nestedProjects: []
}

export function createWorkspaceAdopt(deps: WorkspaceAdoptDeps) {
  const { git } = deps
  const claudeDir = (path: string) => join(deps.home, '.claude', 'projects', claudeProjectKey(path))
  const relink = createAdoptRelink({
    git,
    journal: deps.journal,
    store: deps.store,
    getRepo: deps.getRepo,
    allRepos: deps.allRepos,
    orbstack: deps.orbstack ?? (() => null),
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
      const inspected: Inspected = {
        repoId,
        from: '',
        to: '',
        blockers: ['not-a-repo'],
        processes: [],
        linkedWorktrees: [],
        worktreesDir: null,
        claudeProjectDir: null,
        relink: NO_RELINK,
        openFiles: [],
        openFilesChecked: false,
        warnings: []
      }
      return { inspected, inputs: null }
    }
    const from = await realpath(repo.path).catch(() => repo.path)
    const to = await targetFor(repo)
    if (isPathInsideWorkspaceRoot(from, deps.root())) {
      blockers.push('already-inside')
    } else if (isPathInsideRoot(deps.root(), from)) {
      // A repo at `~` holds `~/pod`: moving it inside itself is EINVAL halfway through.
      blockers.push('contains-root')
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
    const skip = new Set(processes.map((process) => process.pid))
    const open = await findOpenFilesInside(deps.processes, folders, skip)
    if (open.files.length > 0) {
      blockers.push('files-open')
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
    if (relinkPlan.orbstackMachines.length > 0) {
      blockers.push('orbstack-machines')
    }
    if (relinkPlan.nestedProjects.length > 0) {
      blockers.push('nested-project')
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
      relink: relinkPlan,
      openFiles: open.files,
      openFilesChecked: open.checked,
      warnings: await adoptWarnings(
        from,
        to,
        relinkPlan.claudeProjectDirs,
        relink.affectedAutomations(inputs)
      )
    }
    return { inspected, inputs }
  }

  // Open files churn (indexers open and close them), so apply checks them afresh, not by fingerprint.
  const fingerprint = (plan: Inspected): string =>
    fingerprintOf([
      plan.from,
      plan.to,
      plan.blockers.filter((blocker) => blocker !== 'files-open').sort(),
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

  const refusal = (refused: readonly PodAdoptBlocker[], current: Inspected): string => {
    const files = refused.includes('files-open')
      ? ` (${current.openFiles.map((file) => `${file.name || file.pid}: ${file.path}`).join(', ')})`
      : ''
    return `Not moved: ${refused.join(', ')}${files}`
  }

  /**
   * Moves the repo, leaves a symlink where it was, lets git re-point its worktrees, then carries
   * Pod's records and Claude's folders to the new path. The record is written before the first
   * rename and after every step, so Move Back works from wherever a failure or a crash stopped it.
   * Processes inside keep running (their cwd moves with the folder) only when the user ticked
   * them; a live Pod terminal always refuses.
   */
  const apply = async (
    planId: string,
    acknowledged: readonly PodAdoptSoftBlocker[] = [],
    runtime: AdoptRelinkRuntime | null = null
  ): Promise<PodAdoptRecord> => {
    const repoId = deps.plans.subjectOf(planId, 'adopt')
    const { inspected: current, inputs } = await inspect(repoId, runtime)
    deps.plans.verify(planId, 'adopt', `adopt:${repoId}`, fingerprint(current))
    const refused = current.blockers.filter(
      (blocker) => !(isSoftBlocker(blocker) && acknowledged.includes(blocker))
    )
    if (refused.length > 0 || !inputs) {
      throw new WorkspacePlanError(refusal(refused, current))
    }
    deps.plans.consume(planId)
    const { from, to } = current
    const relinked: PodAdoptRelinkRecord = {
      repoPath: inputs.repo.path,
      repoPathAfter: inputs.repo.path,
      worktreeIds: [],
      claudeProjectDirs: [],
      historyDirs: [],
      configPaths: [],
      orbstackKeys: []
    }
    const record: PodAdoptRecord = {
      id: randomUUID(),
      repoId,
      from,
      to,
      movedAt: (deps.now ?? Date.now)(),
      repoMoved: false,
      worktreesDirMoved: false,
      claudeProjectDirMoved: false,
      progress: 'moving',
      relink: relinked
    }
    const save = () => saveAdoptRecord(deps.journal, record)
    await save()
    await stopWatchers(git, [from, ...current.linkedWorktrees])
    await mkdir(dirname(to), { recursive: true })
    await rename(from, to)
    // Orca, shells and scripts that still name the old path keep working through it.
    await symlink(to, from)
    record.repoMoved = true
    await save()
    const moves: AdoptMove[] = [[from, to]]
    if (current.worktreesDir) {
      await rename(current.worktreesDir, worktreesDirOf(to))
      await symlink(worktreesDirOf(to), current.worktreesDir)
      record.worktreesDirMoved = true
      moves.push([current.worktreesDir, worktreesDirOf(to)])
      await save()
    }
    const linked = current.linkedWorktrees.map((path) => remap(path, moves))
    const repair = await git(['worktree', 'repair', ...linked], to)
    if (repair.code !== 0) {
      // The old paths still resolve through the links; stop here, so Move Back has little to undo.
      record.repairError = repair.stderr.trim() || 'git worktree repair failed'
      await save()
      throw new Error(`Moved, but git could not repair the worktree links: ${record.repairError}`)
    }
    record.progress = 'moved'
    await save()
    await relink.apply(inputs, current.relink.configPaths, runtime, relinked, async () => {
      record.claudeProjectDirMoved = relinked.claudeProjectDirs.some(
        ([old]) => old === current.claudeProjectDir
      )
      await save()
    })
    record.progress = 'relinked'
    await save()
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
