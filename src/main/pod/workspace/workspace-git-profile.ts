import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  POD_GIT_PROFILE_LARGE_REPO_FILES,
  POD_OPT_IN_KEYS,
  planPodGitProfile
} from '../../../shared/pod-workspace-git-profile'
import type {
  PodProfileOptInId,
  PodTuneRecord,
  PodWorkspaceGitProfile
} from '../../../shared/pod-workspace-tidy-types'
import type { Repo } from '../../../shared/repo-types'
import {
  createGitHostFactsReader,
  currentFromEntries,
  readProfileConfig,
  readRepoProfileFacts
} from './workspace-git-profile-facts'
import { applyOrcaTuning, planOrcaTuning, revertOrcaTuning } from './workspace-git-profile-orca'
import {
  createBackfillEstimator,
  isKeyOptIn,
  migrateRefFormat,
  planOptIns,
  startBackfill
} from './workspace-git-profile-optins'
import { createPodKeyWriter } from './workspace-git-profile-pod-keys'
import type { WorkspaceGitExec } from './workspace-git-exec'
import type { WorkspaceJournal } from './workspace-journal'
import { fingerprintOf, WorkspacePlanError, type WorkspacePlanStore } from './workspace-plan-store'

export type WorkspaceGitProfileDeps = {
  git: WorkspaceGitExec
  home: string
  journal: WorkspaceJournal
  plans: WorkspacePlanStore
  getRepo: (repoId: string) => Repo | undefined
  now?: () => number
  /** Where a finished background job (backfill) reports. */
  onBackgroundDone?: (repoId: string, message: string) => void
}

export type PodTuneResult = {
  ok: boolean
  message: string
  tune?: PodTuneRecord
  removed?: string[]
}

type Inspection = {
  profile: Omit<PodWorkspaceGitProfile, 'planId' | 'expiresAt'>
  fingerprint: string
  fsmonitor: boolean
}

export function createWorkspaceGitProfile(deps: WorkspaceGitProfileDeps) {
  const { git, journal, plans } = deps
  const now = deps.now ?? Date.now
  const hostFacts = createGitHostFactsReader(git, deps.home)
  const keys = createPodKeyWriter(git, deps.home)
  const estimate = createBackfillEstimator()

  const localRepo = (repoId: string): Repo => {
    const repo = deps.getRepo(repoId)
    if (!repo) {
      throw new WorkspacePlanError('That repository is no longer in Pod.')
    }
    if (repo.connectionId || repo.kind === 'folder') {
      throw new WorkspacePlanError('Pod tunes git repositories on this Mac only.')
    }
    return repo
  }

  const inspect = async (repo: Repo): Promise<Inspection> => {
    const [host, entries] = await Promise.all([hostFacts(), readProfileConfig(git, repo.path)])
    const facts = await readRepoProfileFacts(git, repo.path, host)
    if (!facts) {
      throw new WorkspacePlanError('Not a git repository.')
    }
    const podRows = planPodGitProfile(facts, currentFromEntries(entries))
    // Why 10k: there the watcher took status from 808 to 135 M instructions; below, a few ms.
    const large = (facts.trackedFiles ?? 0) >= POD_GIT_PROFILE_LARGE_REPO_FILES
    const orca = await planOrcaTuning(repo, large, join(facts.gitDir, 'index'))
    // Keep a watcher Orca already set (its own opt-in): its apply would otherwise take it back.
    const fsmonitor =
      large || orca.rows.some((row) => row.key === 'core.fsmonitor' && row.action === 'keep')
    const rows = [...orca.rows, ...podRows]
    const optIns = planOptIns(host, facts, podRows, estimate(facts, repo.path))
    const tunes = (await journal.read()).tunes.filter((tune) => tune.repoId === repo.id)
    const maintenanceRegistered = await keys.isRegistered(repo.path)
    return {
      profile: {
        repoPath: repo.path,
        rows,
        optIns,
        trackedFiles: facts.trackedFiles,
        packCount: facts.packCount,
        partialClone: facts.partialClone,
        refFormat: facts.refFormat,
        maintenanceRegistered,
        applied: rows.filter((row) => row.action === 'keep').length,
        pending: rows.filter((row) => row.action === 'set').length,
        tunes
      },
      fsmonitor,
      fingerprint: fingerprintOf([
        rows.map((row) => [row.key, row.action, row.value, row.current]),
        optIns.map((optIn) => [optIn.id, optIn.available, optIn.active]),
        facts.refFormat,
        facts.linkedWorktrees,
        maintenanceRegistered,
        orca.snapshot
      ])
    }
  }

  const plan = async (repoId: string): Promise<PodWorkspaceGitProfile> => {
    const repo = localRepo(repoId)
    const { fingerprint, profile } = await inspect(repo)
    const fingerprints = new Map([[`profile:${repo.id}`, fingerprint]])
    for (const tune of profile.tunes) {
      fingerprints.set(`tune:${tune.id}`, fingerprintOf(tune))
    }
    return { ...plans.issue('profile', fingerprints, repo.id), ...profile }
  }

  const verified = async (planId: string): Promise<{ repo: Repo; current: Inspection }> => {
    const repo = localRepo(plans.subjectOf(planId, 'profile'))
    const current = await inspect(repo)
    plans.verify(planId, 'profile', `profile:${repo.id}`, current.fingerprint)
    return { repo, current }
  }

  const apply = async (
    planId: string,
    optIns: readonly PodProfileOptInId[] = []
  ): Promise<PodTuneResult> => {
    const { repo, current } = await verified(planId)
    const { profile } = current
    for (const id of optIns) {
      const optIn = profile.optIns.find((entry) => entry.id === id)
      if (!optIn?.available || optIn.active) {
        throw new WorkspacePlanError(`${id}: ${optIn?.note ?? 'not offered for this repository'}`)
      }
    }
    plans.consume(planId)
    const tune: PodTuneRecord = {
      id: randomUUID(),
      repoId: repo.id,
      repoPath: repo.path,
      appliedAt: now(),
      orcaKeys: [],
      podKeys: [],
      registeredMaintenance: false,
      optIns: []
    }
    try {
      tune.orcaKeys = await applyOrcaTuning(repo, current.fsmonitor)
      const wanted = profile.rows
        .filter((row) => row.source === 'pod' && row.action === 'set')
        .map((row) => ({ key: row.key, value: row.value }))
      for (const id of optIns.filter(isKeyOptIn)) {
        wanted.push({ key: POD_OPT_IN_KEYS[id], value: 'true' })
      }
      for (const entry of wanted) {
        await keys.set(repo.path, entry.key, entry.value)
        tune.podKeys.push(entry.key)
      }
      const strategy = profile.rows.find((row) => row.key === 'maintenance.strategy')
      if (strategy?.action === 'set' || strategy?.action === 'keep') {
        tune.registeredMaintenance = await keys.registerMaintenance(repo.path)
      }
      if (optIns.includes('reftable')) {
        await migrateRefFormat(git, repo.path, 'reftable')
      }
      tune.optIns = [...optIns]
    } finally {
      // Whatever got written is recorded, so even a failed apply can be undone.
      if (tune.orcaKeys.length + tune.podKeys.length > 0 || tune.registeredMaintenance) {
        await journal.update((data) => void data.tunes.push(tune))
      }
    }
    if (optIns.includes('backfill')) {
      startBackfill(git, repo.path, (error) =>
        deps.onBackgroundDone?.(repo.id, error ?? 'Backfill finished: history searches stay local.')
      )
    }
    const changed = tune.orcaKeys.length + tune.podKeys.length + tune.optIns.length
    return {
      ok: true,
      message: changed > 0 ? `Tuned ${changed} settings` : 'Nothing to change',
      tune
    }
  }

  /** Takes back one apply: only values still as Pod or Orca wrote them; a changed one stays. */
  const undo = async (planId: string, tuneId: string): Promise<PodTuneResult> => {
    const repo = localRepo(plans.subjectOf(planId, 'profile'))
    const tune = (await journal.read()).tunes.find((entry) => entry.id === tuneId)
    plans.verify(planId, 'profile', `tune:${tuneId}`, tune ? fingerprintOf(tune) : 'gone')
    if (!tune) {
      throw new WorkspacePlanError('That change was already undone.')
    }
    plans.consume(planId)
    const removed = [
      ...(await revertOrcaTuning(repo, tune.orcaKeys)),
      ...(await keys.unset(repo.path, tune.podKeys))
    ]
    if (tune.registeredMaintenance) {
      await keys.unregisterMaintenance(repo.path)
      removed.push('maintenance')
    }
    let note = ''
    if (tune.optIns.includes('reftable')) {
      const facts = await readRepoProfileFacts(git, repo.path, await hostFacts())
      if (facts?.refFormat === 'reftable' && facts.linkedWorktrees === 0) {
        await migrateRefFormat(git, repo.path, 'files')
        removed.push('reftable')
      } else if (facts?.refFormat === 'reftable') {
        note = ' Refs stay in reftable: git converts only without linked worktrees.'
      }
    }
    await journal.update((data) => {
      data.tunes = data.tunes.filter((entry) => entry.id !== tuneId)
    })
    return { ok: true, message: `Undid ${removed.length} settings.${note}`, removed }
  }

  return { plan, apply, undo }
}

export type WorkspaceGitProfileService = ReturnType<typeof createWorkspaceGitProfile>
