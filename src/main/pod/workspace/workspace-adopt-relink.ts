// Fork-only (Pod): what follows a repo when Move In renames its folder: Pod's own records (the repo
// row, worktree ids, shell history, OrbStack keys, the journal), Claude Code's project folders,
// and the absolute paths git keeps into it. Planned before the move, applied after it, taken back
// by Move Back; each step is recorded as it lands.
import { readlink, rename, symlink, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type {
  PodAdoptConfigPath,
  PodAdoptRelinkPlan,
  PodAdoptRelinkRecord
} from '../../../shared/pod-workspace-tidy-types'
import type { Repo } from '../../../shared/repo-types'
import { WORKTREE_ID_SEPARATOR } from '../../../shared/worktree/id'
import type { PodOrbstackWorktreeKeys } from '../orbstack/pod-orbstack-worktree-keys'
import { hashWorktreeId } from '../../terminal-history-id'
import { findConfigPaths, rewriteConfigPath } from './workspace-adopt-config'
import {
  claudeProjectKey,
  pathExists,
  pathOfWorktreeId as pathOf,
  remapPath,
  reverseMoves,
  type AdoptMove
} from './workspace-adopt-paths'
import type { WorkspaceGitExec } from './workspace-git-exec'
import type { WorkspaceJournal } from './workspace-journal'

export { claudeProjectKey, remapPath, reverseMoves, type AdoptMove }

type RelinkedRepoFields = Pick<
  Repo,
  | 'path'
  | 'worktreeBasePath'
  | 'externalWorktreeInboxBaselinePaths'
  | 'importedExternalWorktreePaths'
  | 'customWorktreeVisibilitySources'
>

type AutomationBinding = {
  name: string
  workspaceMode: string
  workspaceId: string | null
}

export type AdoptRelinkStore = {
  getAllWorktreeMeta(): Record<string, unknown>
  migrateWorktreeIdentity(oldWorktreeId: string, newWorktreeId: string): void
  updateRepo(id: string, updates: Partial<RelinkedRepoFields>): Repo | null
  /** Automations, for the ones bound to a worktree that moves; absent where there are none. */
  listAutomations?(): readonly AutomationBinding[]
}

/** The runtime's half, bound per call by the RPC handler. */
export type AdoptRelinkRuntime = {
  /** The ids among these that have a live Pod terminal, or that it could not check. */
  liveTerminalWorktrees(worktreeIds: readonly string[]): Promise<string[]>
  notifyWorktreeRenamed(repoId: string, oldWorktreeId: string, newWorktreeId: string): void
  /** Repo rows changed: drop resolved worktrees and file-access roots, tell every client. */
  notifyReposChanged(): void
}

export type AdoptRelinkDeps = {
  git: WorkspaceGitExec
  journal: WorkspaceJournal
  store: AdoptRelinkStore
  getRepo: (repoId: string) => Repo | undefined
  allRepos: () => readonly Repo[]
  orbstack: () => PodOrbstackWorktreeKeys | null
  home: string
  historyRoot: string
}

/** What the plan read before the move; the apply works from the same values. */
export type AdoptRelinkInputs = {
  repo: Repo
  moves: readonly AdoptMove[]
  /** Checkout paths as git lists them before the move. */
  checkouts: readonly string[]
  repoPathAfter: string
}

function repoFields(repo: Repo, moves: readonly AdoptMove[], path: string) {
  const remapAll = (paths: string[]) => paths.map((entry) => remapPath(entry, moves))
  const updates: Partial<RelinkedRepoFields> = { path }
  if (repo.worktreeBasePath) {
    updates.worktreeBasePath = remapPath(repo.worktreeBasePath, moves)
  }
  if (repo.externalWorktreeInboxBaselinePaths) {
    updates.externalWorktreeInboxBaselinePaths = remapAll(repo.externalWorktreeInboxBaselinePaths)
  }
  if (repo.importedExternalWorktreePaths) {
    updates.importedExternalWorktreePaths = remapAll(repo.importedExternalWorktreePaths)
  }
  if (repo.customWorktreeVisibilitySources) {
    updates.customWorktreeVisibilitySources = repo.customWorktreeVisibilitySources.map(
      (source) => ({ ...source, rootPath: remapPath(source.rootPath, moves) })
    )
  }
  return updates
}

export function createAdoptRelink(deps: AdoptRelinkDeps) {
  const { git } = deps
  const claudeDir = (path: string) => join(deps.home, '.claude', 'projects', claudeProjectKey(path))
  const historyDir = (worktreeId: string) => join(deps.historyRoot, hashWorktreeId(worktreeId))

  /** Ids stored for this repo whose folder lies inside one of the moves, re-rooted by them. */
  const storedPairs = (repoId: string, moves: readonly AdoptMove[]): [string, string][] => {
    const prefix = `${repoId}${WORKTREE_ID_SEPARATOR}`
    return Object.keys(deps.store.getAllWorktreeMeta())
      .filter((id) => id.startsWith(prefix))
      .map((id): [string, string] => [id, `${prefix}${remapPath(id.slice(prefix.length), moves)}`])
      .filter(([from, to]) => from !== to)
  }

  /** Every id Pod may hold for this repo's checkouts, git's spelling and the stored ones alike. */
  const worktreeIdPairs = (inputs: AdoptRelinkInputs): [string, string][] => {
    const { repo, moves } = inputs
    const prefix = `${repo.id}${WORKTREE_ID_SEPARATOR}`
    const pairs = new Map<string, string>([
      [`${prefix}${repo.path}`, `${prefix}${inputs.repoPathAfter}`]
    ])
    for (const path of inputs.checkouts) {
      pairs.set(`${prefix}${path}`, `${prefix}${remapPath(path, moves)}`)
    }
    for (const [from, to] of storedPairs(repo.id, moves)) {
      pairs.set(from, to)
    }
    return [...pairs].filter(([from, to]) => from !== to)
  }

  const affectedAutomations = (inputs: AdoptRelinkInputs): string[] => {
    const moving = new Set(worktreeIdPairs(inputs).map(([from]) => from))
    return (deps.store.listAutomations?.() ?? [])
      .filter((entry) => entry.workspaceMode === 'existing' && entry.workspaceId !== null)
      .filter((entry) => moving.has(entry.workspaceId ?? ''))
      .map((entry) => entry.name)
  }

  const plan = async (
    inputs: AdoptRelinkInputs,
    runtime: AdoptRelinkRuntime | null
  ): Promise<PodAdoptRelinkPlan> => {
    const pairs = worktreeIdPairs(inputs)
    const worktrees = pairs.map(([from, to]): [string, string] => [pathOf(from), pathOf(to)])
    const claudeProjectDirs: [string, string][] = []
    let historyDirs = 0
    for (const [from, to] of pairs) {
      const [oldClaude, newClaude] = [claudeDir(pathOf(from)), claudeDir(pathOf(to))]
      const listed = claudeProjectDirs.some(([dir]) => dir === oldClaude)
      if (!listed && (await pathExists(oldClaude)) && !(await pathExists(newClaude))) {
        claudeProjectDirs.push([oldClaude, newClaude])
      }
      historyDirs += (await pathExists(historyDir(from))) ? 1 : 0
    }
    // Only checkouts on disk can hold a terminal; an id kept for a gone folder has none.
    const onDisk = new Set([inputs.repo.path, ...inputs.checkouts])
    const live = runtime
      ? await runtime.liveTerminalWorktrees(
          pairs.map(([from]) => from).filter((id) => onDisk.has(pathOf(id)))
        )
      : []
    const nestedProjects = deps
      .allRepos()
      .filter(
        (other) => other.id !== inputs.repo.id && remapPath(other.path, inputs.moves) !== other.path
      )
      .map((other) => other.path)
    return {
      worktrees,
      claudeProjectDirs,
      historyDirs,
      configPaths: await findConfigPaths(git, inputs.repo.path, inputs.repoPathAfter, inputs.moves),
      terminalsOpen: live.map(pathOf),
      orbstackMachines: deps.orbstack()?.machinesFor(pairs.map(([from]) => from)) ?? [],
      nestedProjects
    }
  }

  const remapJournal = (repoId: string, moves: readonly AdoptMove[]) =>
    deps.journal.update((data) => {
      for (const archive of data.archives.filter((entry) => entry.repoId === repoId)) {
        archive.repoPath = remapPath(archive.repoPath, moves)
        archive.path = remapPath(archive.path, moves)
      }
      for (const trashed of data.trashed.filter((entry) => entry.repoId === repoId)) {
        trashed.path = remapPath(trashed.path, moves)
      }
    })

  /**
   * After the folders moved. Fills `record` step by step and saves it after each, so a failure or
   * a crash part way leaves a record Move Back takes back as far as it got.
   */
  const apply = async (
    inputs: AdoptRelinkInputs,
    planned: readonly PodAdoptConfigPath[],
    runtime: AdoptRelinkRuntime | null,
    record: PodAdoptRelinkRecord,
    save: () => Promise<void>
  ): Promise<void> => {
    const { repo, moves } = inputs
    const pairs = worktreeIdPairs(inputs)
    for (const [from, to] of pairs) {
      const [oldClaude, newClaude] = [claudeDir(pathOf(from)), claudeDir(pathOf(to))]
      if ((await pathExists(oldClaude)) && !(await pathExists(newClaude))) {
        await rename(oldClaude, newClaude)
        // A session still running under the old key keeps writing into the new folder.
        await symlink(basename(newClaude), oldClaude)
        record.claudeProjectDirs.push([oldClaude, newClaude])
        await save()
      }
      const [oldHistory, newHistory] = [historyDir(from), historyDir(to)]
      if ((await pathExists(oldHistory)) && !(await pathExists(newHistory))) {
        await rename(oldHistory, newHistory)
        record.historyDirs.push([oldHistory, newHistory])
        await save()
      }
    }
    for (const entry of planned) {
      if (await rewriteConfigPath(git, entry, entry.to, entry.from, inputs.repoPathAfter)) {
        record.configPaths.push(entry)
      }
    }
    if (!deps.store.updateRepo(repo.id, repoFields(repo, moves, inputs.repoPathAfter))) {
      throw new Error('the project is no longer in Pod')
    }
    record.repoPathAfter = inputs.repoPathAfter
    for (const [from, to] of pairs) {
      deps.store.migrateWorktreeIdentity(from, to)
      record.worktreeIds.push([from, to])
      runtime?.notifyWorktreeRenamed(repo.id, from, to)
    }
    record.orbstackKeys = deps.orbstack()?.rekey(pairs) ?? []
    await save()
    await remapJournal(repo.id, moves)
    runtime?.notifyReposChanged()
  }

  /**
   * The ids Move Back re-keys: the record's, plus any worktree added under the new folders since.
   * `moves` are Move In's own (`from` → `to`).
   */
  const undoPairs = (repoId: string, record: PodAdoptRelinkRecord, moves: readonly AdoptMove[]) => {
    const pairs = new Map(record.worktreeIds.map(([from, to]): [string, string] => [to, from]))
    for (const [to, from] of storedPairs(repoId, reverseMoves(moves))) {
      if (!pairs.has(to)) {
        pairs.set(to, from)
      }
    }
    return [...pairs]
  }

  /**
   * After the folders moved back (`configCwd` is where the repo's config now is). Takes each step
   * back only where it still holds what Move In wrote, and drops it from the record once done.
   */
  const undo = async (
    repoId: string,
    record: PodAdoptRelinkRecord,
    moves: readonly AdoptMove[],
    configCwd: string,
    runtime: AdoptRelinkRuntime | null,
    save: () => Promise<void>
  ): Promise<void> => {
    const back = reverseMoves(moves)
    const repo = deps.getRepo(repoId)
    if (repo && repo.path === record.repoPathAfter) {
      deps.store.updateRepo(repoId, repoFields(repo, back, record.repoPath))
    }
    const pairs = undoPairs(repoId, record, moves)
    for (const [to, from] of pairs) {
      deps.store.migrateWorktreeIdentity(to, from)
      runtime?.notifyWorktreeRenamed(repoId, to, from)
    }
    deps.orbstack()?.rekey(pairs)
    record.worktreeIds = []
    record.orbstackKeys = []
    record.repoPathAfter = record.repoPath
    await save()
    for (const entry of record.configPaths) {
      await rewriteConfigPath(git, entry, entry.from, entry.to, configCwd)
      record.configPaths = record.configPaths.filter((other) => other !== entry)
    }
    for (const [oldHistory, newHistory] of record.historyDirs) {
      if (!(await pathExists(oldHistory)) && (await pathExists(newHistory))) {
        await rename(newHistory, oldHistory)
      }
      record.historyDirs = record.historyDirs.filter(([dir]) => dir !== oldHistory)
    }
    for (const [oldClaude, newClaude] of record.claudeProjectDirs) {
      // Only where the old name is still Pod's link.
      if ((await readlink(oldClaude).catch(() => null)) === basename(newClaude)) {
        await unlink(oldClaude)
        await rename(newClaude, oldClaude)
      }
      record.claudeProjectDirs = record.claudeProjectDirs.filter(([dir]) => dir !== oldClaude)
    }
    await save()
    await remapJournal(repoId, back)
    runtime?.notifyReposChanged()
  }

  return { plan, apply, undo, undoPairs, affectedAutomations }
}

export type AdoptRelink = ReturnType<typeof createAdoptRelink>
