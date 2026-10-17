// Fork-only (Pod): what follows a repo when Move In renames its folder: Pod's own records (the repo
// row, worktree ids, shell history, the journal), Claude Code's project folders, and the absolute
// paths git keeps into it. Planned before the move, applied after it, taken back by Move Back.
import { lstat, readlink, rename, symlink, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type {
  PodAdoptConfigPath,
  PodAdoptRelinkPlan,
  PodAdoptRelinkRecord
} from '../../../shared/pod-workspace-tidy-types'
import type { Repo } from '../../../shared/repo-types'
import { splitWorktreeIdForFilesystem, WORKTREE_ID_SEPARATOR } from '../../../shared/worktree/id'
import { hashWorktreeId } from '../../terminal-history-id'
import type { WorkspaceGitExec } from './workspace-git-exec'
import type { WorkspaceJournal } from './workspace-journal'

/** `[from, to]`: a folder Move In renames. */
export type AdoptMove = readonly [string, string]

type RelinkedRepoFields = Pick<
  Repo,
  | 'path'
  | 'worktreeBasePath'
  | 'externalWorktreeInboxBaselinePaths'
  | 'importedExternalWorktreePaths'
  | 'customWorktreeVisibilitySources'
>

export type AdoptRelinkStore = {
  getAllWorktreeMeta(): Record<string, unknown>
  migrateWorktreeIdentity(oldWorktreeId: string, newWorktreeId: string): void
  updateRepo(id: string, updates: Partial<RelinkedRepoFields>): Repo | null
}

/** The runtime's half, bound per call by the RPC handler. */
export type AdoptRelinkRuntime = {
  /** The ids among these that have a live Pod terminal. */
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

/** Claude Code keys a project's history by its cwd with every non-alphanumeric as `-`. */
export function claudeProjectKey(path: string): string {
  return path.replace(/[^A-Za-z0-9]/g, '-')
}

/** A path inside a moved folder, re-rooted at the folder's new place. */
export function remapPath(path: string, moves: readonly AdoptMove[]): string {
  for (const [from, to] of moves) {
    if (path === from || path.startsWith(`${from}/`)) {
      return to + path.slice(from.length)
    }
  }
  return path
}

export function reverseMoves(moves: readonly AdoptMove[]): AdoptMove[] {
  return moves.map(([from, to]) => [to, from] as const)
}

async function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false
  )
}

const pathOf = (worktreeId: string): string =>
  splitWorktreeIdForFilesystem(worktreeId)?.worktreePath ?? worktreeId

/** `git config --list -z`: `key\nvalue` per entry; a key set with no value has no newline. */
function parseConfigList(stdout: string): [string, string][] {
  return stdout
    .split('\0')
    .filter((entry) => entry.includes('\n'))
    .map((entry) => [entry.slice(0, entry.indexOf('\n')), entry.slice(entry.indexOf('\n') + 1)])
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

  /** Every id Pod may hold for this repo's checkouts, git's spelling and the stored ones alike. */
  const worktreeIdPairs = (inputs: AdoptRelinkInputs): [string, string][] => {
    const { repo, moves } = inputs
    const prefix = `${repo.id}${WORKTREE_ID_SEPARATOR}`
    const main = `${prefix}${repo.path}`
    const ids = new Set([
      main,
      ...inputs.checkouts.map((path) => `${prefix}${path}`),
      ...Object.keys(deps.store.getAllWorktreeMeta()).filter((id) => id.startsWith(prefix))
    ])
    const pairs: [string, string][] = []
    for (const id of ids) {
      const path = pathOf(id)
      const next =
        id === main
          ? `${prefix}${inputs.repoPathAfter}`
          : id.replace(`${prefix}${path}`, `${prefix}${remapPath(path, moves)}`)
      if (next !== id) {
        pairs.push([id, next])
      }
    }
    return pairs
  }

  const configPaths = async (inputs: AdoptRelinkInputs): Promise<PodAdoptConfigPath[]> => {
    const { repo, moves } = inputs
    const [local, global] = await Promise.all([
      git(['config', '--local', '--list', '-z'], repo.path),
      git(['config', '--global', '--get-all', 'maintenance.repo'], repo.path)
    ])
    const found: PodAdoptConfigPath[] = []
    for (const [key, value] of local.code === 0 ? parseConfigList(local.stdout) : []) {
      if (remapPath(value, moves) !== value) {
        found.push({ scope: 'local', key, from: value, to: remapPath(value, moves) })
      }
    }
    for (const value of global.code === 0 ? global.stdout.split('\n').filter(Boolean) : []) {
      const next = value === repo.path ? inputs.repoPathAfter : remapPath(value, moves)
      if (next !== value) {
        found.push({ scope: 'global', key: 'maintenance.repo', from: value, to: next })
      }
    }
    return found
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
    return {
      worktrees,
      claudeProjectDirs,
      historyDirs,
      configPaths: await configPaths(inputs),
      terminalsOpen: live.map(pathOf)
    }
  }

  const rewriteConfig = async (
    entry: PodAdoptConfigPath,
    value: string,
    previous: string,
    cwd: string
  ) =>
    (
      await git(
        [
          'config',
          `--${entry.scope}`,
          '--fixed-value',
          '--replace-all',
          entry.key,
          value,
          previous
        ],
        cwd
      )
    ).code === 0

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
   * After the folders moved. Fills `record` as it goes, so a failure part way still leaves a record
   * that Move Back takes back step for step.
   */
  const apply = async (
    inputs: AdoptRelinkInputs,
    planned: readonly PodAdoptConfigPath[],
    runtime: AdoptRelinkRuntime | null,
    record: PodAdoptRelinkRecord
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
      }
      const [oldHistory, newHistory] = [historyDir(from), historyDir(to)]
      if ((await pathExists(oldHistory)) && !(await pathExists(newHistory))) {
        await rename(oldHistory, newHistory)
        record.historyDirs.push([oldHistory, newHistory])
      }
    }
    for (const entry of planned) {
      if (await rewriteConfig(entry, entry.to, entry.from, inputs.repoPathAfter)) {
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
    await remapJournal(repo.id, moves)
    runtime?.notifyReposChanged()
  }

  /** Before the folders move back; each step only where it still holds what Move In wrote. */
  const undo = async (
    repoId: string,
    record: PodAdoptRelinkRecord,
    moves: readonly AdoptMove[],
    runtime: AdoptRelinkRuntime | null
  ): Promise<void> => {
    const back = reverseMoves(moves)
    const repo = deps.getRepo(repoId)
    if (repo && repo.path === record.repoPathAfter) {
      deps.store.updateRepo(repoId, repoFields(repo, back, record.repoPath))
    }
    for (const [from, to] of record.worktreeIds.toReversed()) {
      deps.store.migrateWorktreeIdentity(to, from)
      runtime?.notifyWorktreeRenamed(repoId, to, from)
    }
    for (const entry of record.configPaths) {
      await rewriteConfig(entry, entry.from, entry.to, record.repoPathAfter)
    }
    for (const [oldHistory, newHistory] of record.historyDirs) {
      if (!(await pathExists(oldHistory))) {
        await rename(newHistory, oldHistory).catch(() => undefined)
      }
    }
    await remapJournal(repoId, back)
    runtime?.notifyReposChanged()
  }

  /** After the folders moved back: Claude's folders, only where the old name is still Pod's link. */
  const undoClaudeDirs = async (record: PodAdoptRelinkRecord): Promise<void> => {
    for (const [oldClaude, newClaude] of record.claudeProjectDirs) {
      if ((await readlink(oldClaude).catch(() => null)) === basename(newClaude)) {
        await unlink(oldClaude)
        await rename(newClaude, oldClaude)
      }
    }
  }

  return { plan, apply, undo, undoClaudeDirs }
}

export type AdoptRelink = ReturnType<typeof createAdoptRelink>
