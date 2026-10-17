// Fork-only (Pod): Move Back, which takes one Move In back from its journal record, as far as that
// Move In got. The record goes only once every step is back; a failure leaves it for a retry.
import { lstat, readlink, rename, unlink } from 'node:fs/promises'
import { basename } from 'node:path'
import type { PodAdoptRecord, PodAdoptUndoPlan } from '../../../shared/pod-workspace-tidy-types'
import { pathExists, remapPath, saveAdoptRecord, type AdoptMove } from './workspace-adopt-paths'
import type { AdoptRelink, AdoptRelinkRuntime } from './workspace-adopt-relink'
import type { WorkspaceGitExec } from './workspace-git-exec'
import type { WorkspaceJournal } from './workspace-journal'
import { fingerprintOf, WorkspacePlanError, type WorkspacePlanStore } from './workspace-plan-store'
import { findProcessesInside, type ProcessCwdReader } from './workspace-process-cwds'
import { parseWorktreePorcelainZ } from './workspace-tidy-git'
import { podWorktreesDirOf as worktreesDirOf } from './workspace-tidy-strays'

export type WorkspaceAdoptUndoDeps = {
  git: WorkspaceGitExec
  journal: WorkspaceJournal
  plans: WorkspacePlanStore
  processes: ProcessCwdReader | null
  relink: AdoptRelink
  claudeDir: (path: string) => string
}

export async function listWorktreePaths(
  git: WorkspaceGitExec,
  repoPath: string
): Promise<string[]> {
  const list = await git(['worktree', 'list', '--porcelain', '-z'], repoPath)
  return list.code === 0 ? parseWorktreePorcelainZ(list.stdout).map((entry) => entry.path) : []
}

export function stopWatchers(git: WorkspaceGitExec, paths: readonly string[]) {
  return Promise.all(paths.map((path) => git(['fsmonitor--daemon', 'stop'], path)))
}

type BackMove = { moved: string; original: string; done: boolean }

/** Move In's own moves (`from` → `to`), for the folders that moved or were moving. */
function forwardMoves(record: PodAdoptRecord): AdoptMove[] {
  const moves: AdoptMove[] = []
  // A record from before `repoMoved` existed moved both, as it says.
  if (record.repoMoved !== false || record.renaming === 'repo') {
    moves.push([record.from, record.to])
  }
  if (record.worktreesDirMoved || record.renaming === 'worktrees') {
    moves.push([worktreesDirOf(record.from), worktreesDirOf(record.to)])
  }
  return moves
}

/**
 * How each moved folder can go back: through Pod's link at the old path, or, after a crash
 * between the rename and the link, straight back to a path nothing holds. `untouched`: the folder
 * never left (a crash before its rename), so there is nothing to take back. Null: something else
 * now sits at the old path, so Pod leaves it alone.
 */
async function backMoveOf([original, moved]: AdoptMove): Promise<BackMove | 'untouched' | null> {
  if ((await readlink(original).catch(() => null)) === moved) {
    return { moved, original, done: false }
  }
  if (!(await pathExists(original)) && (await pathExists(moved))) {
    return { moved, original, done: false }
  }
  if ((await lstat(original).catch(() => null))?.isDirectory() && !(await pathExists(moved))) {
    return 'untouched'
  }
  return null
}

export function createWorkspaceAdoptUndo(deps: WorkspaceAdoptUndoDeps) {
  const { git } = deps

  const recordOf = async (recordId: string): Promise<PodAdoptRecord> => {
    const record = (await deps.journal.read()).adoptions.find((entry) => entry.id === recordId)
    if (!record) {
      throw new WorkspacePlanError('That move was already undone.')
    }
    return record
  }

  const inspectUndo = async (
    record: PodAdoptRecord,
    runtime: AdoptRelinkRuntime | null
  ): Promise<Omit<PodAdoptUndoPlan, 'planId' | 'expiresAt'>> => {
    const blockers: PodAdoptUndoPlan['blockers'] = []
    const moves = forwardMoves(record)
    if ((await Promise.all(moves.map(backMoveOf))).some((back) => back === null)) {
      blockers.push('link-changed')
    }
    const folders = moves.map(([, moved]) => moved)
    const inside = deps.processes ? await findProcessesInside(deps.processes, folders) : new Map()
    const processes = folders.flatMap((folder) => inside.get(folder) ?? [])
    if (processes.length > 0) {
      blockers.push('process-inside')
    }
    // A pane whose shell left the folder still runs under an id Move Back would re-key.
    const ids = record.relink ? deps.relink.undoPairs(record.repoId, record.relink, moves) : []
    const live = runtime ? await runtime.liveTerminalWorktrees(ids.map(([to]) => to)) : []
    if (live.length > 0) {
      blockers.push('terminals-open')
    }
    return { record, blockers, processes }
  }

  const undoFingerprint = (plan: Omit<PodAdoptUndoPlan, 'planId' | 'expiresAt'>): string =>
    fingerprintOf([plan.record, plan.blockers, plan.processes.map((process) => process.pid)])

  const planUndo = async (
    recordId: string,
    runtime: AdoptRelinkRuntime | null = null
  ): Promise<PodAdoptUndoPlan> => {
    const inspected = await inspectUndo(await recordOf(recordId), runtime)
    const fingerprints = new Map([[`adopt-undo:${recordId}`, undoFingerprint(inspected)]])
    return { ...deps.plans.issue('adopt-undo', fingerprints, recordId), ...inspected }
  }

  /** A record from a Pod that moved only the repo's own Claude folder. */
  const undoLegacyClaudeDir = async (record: PodAdoptRecord): Promise<void> => {
    const oldClaude = deps.claudeDir(record.from)
    if (
      record.claudeProjectDirMoved &&
      (await readlink(oldClaude).catch(() => null)) === basename(deps.claudeDir(record.to))
    ) {
      await unlink(oldClaude)
      await rename(deps.claudeDir(record.to), oldClaude)
    }
  }

  /**
   * Always refused with a process or a live Pod terminal inside: moving a folder back under a
   * running agent is not undo. Folders first, then git's links, then Pod's records, each saved.
   */
  const undo = async (
    planId: string,
    runtime: AdoptRelinkRuntime | null = null
  ): Promise<PodAdoptRecord> => {
    const recordId = deps.plans.subjectOf(planId, 'adopt-undo')
    const current = await inspectUndo(await recordOf(recordId), runtime)
    deps.plans.verify(planId, 'adopt-undo', `adopt-undo:${recordId}`, undoFingerprint(current))
    if (current.blockers.length > 0) {
      throw new WorkspacePlanError(`Not moved back: ${current.blockers.join(', ')}`)
    }
    deps.plans.consume(planId)
    const { record } = current
    const save = () => saveAdoptRecord(deps.journal, record)
    const moves = forwardMoves(record)
    const backs = await Promise.all(moves.map(backMoveOf))
    const worktrees = (await pathExists(record.to)) ? await listWorktreePaths(git, record.to) : []
    await stopWatchers(git, worktrees)
    for (const back of backs) {
      if (!back || back === 'untouched') {
        continue
      }
      if ((await readlink(back.original).catch(() => null)) === back.moved) {
        await unlink(back.original)
      }
      await rename(back.moved, back.original)
      Object.assign(
        record,
        back.moved === record.to ? { repoMoved: false } : { worktreesDirMoved: false }
      )
      await save()
    }
    const linked = worktrees
      .filter((path) => path !== record.to)
      .map((path) =>
        remapPath(
          path,
          moves.map(([from, to]) => [to, from] as const)
        )
      )
    const repair = await git(['worktree', 'repair', ...linked], record.from)
    if (repair.code !== 0) {
      record.repairError = repair.stderr.trim() || 'git worktree repair failed'
      await save()
      throw new Error(
        `Moved back, but git could not repair the worktree links: ${record.repairError}`
      )
    }
    await (record.relink
      ? deps.relink.undo(record.repoId, record.relink, moves, record.from, runtime, save)
      : undoLegacyClaudeDir(record))
    await deps.journal.update((data) => {
      data.adoptions = data.adoptions.filter((entry) => entry.id !== recordId)
    })
    return record
  }

  return { planUndo, undo }
}
