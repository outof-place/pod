import { access, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import {
  POD_GIT_PROFILE_RECORD_KEY,
  planPodGitProfile,
  type PodGitProfileRow
} from '../../../shared/pod-workspace-git-profile'
import type { PodWorkspaceGitProfile } from '../../../shared/pod-workspace-tidy-types'
import {
  createGitHostFactsReader,
  currentFromEntries,
  parseProfileRecord,
  readProfileConfig,
  readRepoProfileFacts
} from './workspace-git-profile-facts'
import type { WorkspaceGitExec } from './workspace-git-exec'

// `git maintenance register` writes this to the repo and it outlives `unregister`.
const MAINTENANCE_AUTO = 'maintenance.auto'
const MAINTENANCE_REGISTERED = 'maintenance.register'
const LAUNCHD_PLISTS = ['hourly', 'daily', 'weekly'].map((schedule) =>
  join('Library', 'LaunchAgents', `org.git-scm.git.${schedule}.plist`)
)

export type WorkspaceGitProfileDeps = {
  git: WorkspaceGitExec
  home: string
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export function createWorkspaceGitProfile(deps: WorkspaceGitProfileDeps) {
  const { git } = deps
  const hostFacts = createGitHostFactsReader(git, deps.home)

  const isRegistered = async (repoPath: string): Promise<boolean> => {
    const result = await git(['config', '--global', '--get-all', 'maintenance.repo'], repoPath)
    // git stores the resolved path; Pod may know the repo by a symlinked one.
    const spellings = new Set([repoPath, await realpath(repoPath).catch(() => repoPath)])
    return result.stdout.split('\n').some((line) => spellings.has(line.trim()))
  }

  const plan = async (repoPath: string): Promise<PodWorkspaceGitProfile | null> => {
    const [host, entries] = await Promise.all([hostFacts(), readProfileConfig(git, repoPath)])
    const facts = await readRepoProfileFacts(git, repoPath, host)
    if (!facts) {
      return null
    }
    const rows = planPodGitProfile(facts, currentFromEntries(entries))
    const record = parseProfileRecord(entries)
    return {
      repoPath,
      rows,
      trackedFiles: facts.trackedFiles,
      packCount: facts.packCount,
      partialClone: facts.partialClone,
      maintenanceRegistered: await isRegistered(repoPath),
      podRegisteredMaintenance: record.get(MAINTENANCE_REGISTERED) === 'true',
      applied: rows.filter((row) => row.action === 'keep' && row.reason === 'already-set').length,
      pending: rows.filter((row) => row.action === 'set').length
    }
  }

  const record = (repoPath: string, key: string, value: string) =>
    git(['config', '--local', '--add', POD_GIT_PROFILE_RECORD_KEY, `${key}=${value}`], repoPath)

  const ensureScheduler = async (repoPath: string): Promise<void> => {
    const present = await Promise.all(LAUNCHD_PLISTS.map((rel) => exists(join(deps.home, rel))))
    if (!present.every(Boolean)) {
      // Writes the launchd agents once; every registered repo shares them.
      await git(['maintenance', 'start', '--scheduler=launchctl'], repoPath, { timeoutMs: 30_000 })
    }
  }

  const registerMaintenance = async (repoPath: string): Promise<void> => {
    if (await isRegistered(repoPath)) {
      return
    }
    const before = await git(['config', '--local', '--get', MAINTENANCE_AUTO], repoPath)
    const result = await git(['maintenance', 'register'], repoPath)
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || 'git maintenance register failed')
    }
    await record(repoPath, MAINTENANCE_REGISTERED, 'true')
    if (before.code !== 0) {
      await record(repoPath, MAINTENANCE_AUTO, 'false')
    }
    await ensureScheduler(repoPath)
  }

  /** Writes the record entry before the key, so a crash between the two never loses provenance. */
  const apply = async (repoPath: string): Promise<PodGitProfileRow[]> => {
    const current = await plan(repoPath)
    if (!current) {
      throw new Error('Not a git repository')
    }
    const written: PodGitProfileRow[] = []
    for (const row of current.rows.filter((entry) => entry.action === 'set')) {
      await record(repoPath, row.key, row.value)
      const result = await git(['config', '--local', row.key, row.value], repoPath)
      if (result.code !== 0) {
        throw new Error(result.stderr.trim() || `git config ${row.key} failed`)
      }
      written.push(row)
    }
    const strategy = current.rows.find((row) => row.key === 'maintenance.strategy')
    if (strategy && (strategy.action === 'set' || strategy.reason === 'already-set')) {
      await registerMaintenance(repoPath)
    }
    return written
  }

  /** Removes only values that still equal what Pod wrote; a value the user changed stays. */
  const revert = async (repoPath: string, worktreePaths: readonly string[]): Promise<string[]> => {
    const recorded = parseProfileRecord(await readProfileConfig(git, repoPath))
    const removed: string[] = []
    for (const [key, value] of recorded) {
      if (key === MAINTENANCE_REGISTERED) {
        await git(['maintenance', 'unregister', '--force'], repoPath)
        removed.push(key)
        continue
      }
      const result = await git(
        ['config', '--local', '--fixed-value', '--unset', key, value],
        repoPath
      )
      if (result.code === 0) {
        removed.push(key)
      }
    }
    await git(['config', '--local', '--unset-all', POD_GIT_PROFILE_RECORD_KEY], repoPath)
    if (removed.includes('core.fsmonitor')) {
      // A daemon outlives the key; stop it in every worktree that may have started one.
      await Promise.all(worktreePaths.map((path) => git(['fsmonitor--daemon', 'stop'], path)))
    }
    return removed
  }

  return { plan, apply, revert }
}

export type WorkspaceGitProfileService = ReturnType<typeof createWorkspaceGitProfile>
