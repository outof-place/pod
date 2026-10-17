// Fork-only (Pod): Move Back, which takes one Move In back from its journal record.
import { readlink, rename, unlink } from 'node:fs/promises'
import { basename } from 'node:path'
import type { PodAdoptRecord, PodAdoptUndoPlan } from '../../../shared/pod-workspace-tidy-types'
import {
  remapPath,
  reverseMoves,
  type AdoptRelink,
  type AdoptRelinkRuntime
} from './workspace-adopt-relink'
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

export function createWorkspaceAdoptUndo(deps: WorkspaceAdoptUndoDeps) {
  const { git } = deps

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

  /** Always refused with a process inside: moving a folder back under a running agent is not undo. */
  const undo = async (
    planId: string,
    runtime: AdoptRelinkRuntime | null = null
  ): Promise<PodAdoptRecord> => {
    const recordId = deps.plans.subjectOf(planId, 'adopt-undo')
    const current = await inspectUndo(await recordOf(recordId))
    deps.plans.verify(planId, 'adopt-undo', `adopt-undo:${recordId}`, undoFingerprint(current))
    if (current.blockers.length > 0) {
      throw new WorkspacePlanError(`Not moved back: ${current.blockers.join(', ')}`)
    }
    deps.plans.consume(planId)
    const { record } = current
    const moves = backMoves(record)
    // Pod's records first, while git's config still sits at the new path.
    if (record.relink) {
      await deps.relink.undo(record.repoId, record.relink, reverseMoves(moves), runtime)
    }
    const worktrees = await listWorktreePaths(git, record.to)
    await stopWatchers(git, worktrees)
    for (const [moved, original] of moves) {
      // Only Pod's own link is replaced; anything else at the old path stays.
      if ((await readlink(original).catch(() => null)) === moved) {
        await unlink(original)
        await rename(moved, original)
      }
    }
    const linked = worktrees.filter((path) => path !== record.to)
    await git(['worktree', 'repair', ...linked.map((path) => remapPath(path, moves))], record.from)
    await (record.relink ? deps.relink.undoClaudeDirs(record.relink) : undoLegacyClaudeDir(record))
    await deps.journal.update((data) => {
      data.adoptions = data.adoptions.filter((entry) => entry.id !== recordId)
    })
    return record
  }

  return { planUndo, undo }
}
