import { access, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { POD_GIT_PROFILE_RECORD_KEY } from '../../../shared/pod-workspace-git-profile'
import { parseProfileRecord, readProfileConfig } from './workspace-git-profile-facts'
import type { WorkspaceGitExec } from './workspace-git-exec'

// `git maintenance register` writes this to the repo and it outlives `unregister`.
const MAINTENANCE_AUTO = 'maintenance.auto'
const LAUNCHD_PLISTS = ['hourly', 'daily', 'weekly'].map((schedule) =>
  join('Library', 'LaunchAgents', `org.git-scm.git.${schedule}.plist`)
)

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false
  )
}

async function mustSucceed(run: ReturnType<WorkspaceGitExec>, what: string): Promise<void> {
  const result = await run
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `${what} failed`)
  }
}

/** Pod's keys and its maintenance registration, each recorded in `pod.workspaceConfig`. */
export function createPodKeyWriter(git: WorkspaceGitExec, home: string) {
  const record = (repoPath: string, key: string, value: string) =>
    mustSucceed(
      git(['config', '--local', '--add', POD_GIT_PROFILE_RECORD_KEY, `${key}=${value}`], repoPath),
      'git config'
    )

  const isRegistered = async (repoPath: string): Promise<boolean> => {
    const result = await git(['config', '--global', '--get-all', 'maintenance.repo'], repoPath)
    // git stores the resolved path; Pod may know the repo by a symlinked one.
    const spellings = new Set([repoPath, await realpath(repoPath).catch(() => repoPath)])
    return result.stdout.split('\n').some((line) => spellings.has(line.trim()))
  }

  /** Record first: a crash between the two then leaves a record with no value, not a stray value. */
  const set = async (repoPath: string, key: string, value: string): Promise<void> => {
    await record(repoPath, key, value)
    await mustSucceed(git(['config', '--local', key, value], repoPath), `git config ${key}`)
  }

  /** True when this call registered the repo; false when it already was. */
  const registerMaintenance = async (repoPath: string): Promise<boolean> => {
    if (await isRegistered(repoPath)) {
      return false
    }
    const before = await git(['config', '--local', '--get', MAINTENANCE_AUTO], repoPath)
    await mustSucceed(git(['maintenance', 'register'], repoPath), 'git maintenance register')
    if (before.code !== 0) {
      await record(repoPath, MAINTENANCE_AUTO, 'false')
    }
    const present = await Promise.all(LAUNCHD_PLISTS.map((rel) => exists(join(home, rel))))
    if (!present.every(Boolean)) {
      // Writes the launchd agents once; every registered repo shares them.
      await git(['maintenance', 'start', '--scheduler=launchctl'], repoPath, { timeoutMs: 30_000 })
    }
    return true
  }

  /** Removes only values that still equal what Pod wrote; a value the user changed stays. */
  const unset = async (repoPath: string, keys: readonly string[]): Promise<string[]> => {
    const recorded = parseProfileRecord(await readProfileConfig(git, repoPath))
    const removed: string[] = []
    for (const key of keys) {
      const value = recorded.get(key.toLowerCase())
      if (value === undefined) {
        continue
      }
      const result = await git(
        ['config', '--local', '--fixed-value', '--unset', key, value],
        repoPath
      )
      if (result.code === 0) {
        removed.push(key)
      }
      await git(
        [
          'config',
          '--local',
          '--fixed-value',
          '--unset-all',
          POD_GIT_PROFILE_RECORD_KEY,
          `${key}=${value}`
        ],
        repoPath
      )
    }
    return removed
  }

  const unregisterMaintenance = async (repoPath: string): Promise<void> => {
    await git(['maintenance', 'unregister', '--force'], repoPath)
    await unset(repoPath, [MAINTENANCE_AUTO])
  }

  return { isRegistered, set, registerMaintenance, unset, unregisterMaintenance }
}

export type PodKeyWriter = ReturnType<typeof createPodKeyWriter>
