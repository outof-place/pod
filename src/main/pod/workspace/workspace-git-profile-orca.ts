// Orca's recommended tuning (#27028) as the base of Pod's git profile: its planner decides its
// keys, its runner writes and records them (`orca.performanceConfig`) and takes them back.
import {
  GIT_PERFORMANCE_CONFIG_MIN_GIT_VERSION,
  isGitVersionAtLeast,
  listUnconfiguredGitPerformanceConfigKeys,
  parseGitVersion,
  planGitPerformanceConfig,
  type GitPerformanceHostFacts
} from '../../../shared/git-performance-config-plan'
import { readGitIndexEntryCount } from '../../../shared/git-performance-config-filesystem'
import {
  probeFsmonitorDaemon,
  readGitPerformanceConfigSnapshot,
  type GitPerformanceConfigHost
} from '../../../shared/git-performance-config-runner'
import {
  isGitPerformanceConfigKey,
  type GitPerformanceConfigKey
} from '../../../shared/git-performance-config-types'
import type { PodGitProfileRow } from '../../../shared/pod-workspace-git-profile'
import type { Repo } from '../../../shared/repo-types'
import { withLocalGitCapabilityCacheForExecution } from '../../git/git-capability-state'
import {
  createLocalGitPerformanceConfigHost,
  runRepoPerformanceConfig
} from '../../git/repo-performance-config'

type OrcaRepo = Pick<Repo, 'id' | 'path' | 'kind' | 'connectionId' | 'executionHostId'>

/** The facts Orca's runner collects before it plans (its own copy is private to the runner). */
async function collectFacts(
  host: GitPerformanceConfigHost,
  open: ReadonlySet<GitPerformanceConfigKey>,
  fsmonitor: boolean,
  indexPath: string
): Promise<GitPerformanceHostFacts> {
  const gitVersion = parseGitVersion((await host.git(['--version'])).stdout)
  const floor = GIT_PERFORMANCE_CONFIG_MIN_GIT_VERSION['core.fsmonitor']
  const canWatch =
    fsmonitor &&
    open.has('core.fsmonitor') &&
    (host.platform === 'darwin' || host.platform === 'win32') &&
    gitVersion !== null &&
    isGitVersionAtLeast(gitVersion, floor.major, floor.minor)
  const [reliableDirectoryMtime, watcher, trackedEntryCount] = await Promise.all([
    open.has('core.untrackedCache') && host.platform !== 'win32'
      ? host.hasReliableDirectoryMtime().catch(() => false)
      : false,
    canWatch
      ? probeFsmonitorDaemon(host).catch(() => 'incompatible' as const)
      : ('unsupported' as const),
    open.has('index.version') ? readGitIndexEntryCount(indexPath).catch(() => null) : null
  ])
  return {
    platform: host.platform,
    gitVersion,
    reliableDirectoryMtime,
    fsmonitorOptedIn: fsmonitor,
    fsmonitor: watcher,
    trackedEntryCount
  }
}

/** Orca's rows as Pod shows them: what its apply would do now, without writing anything. */
export function planOrcaTuning(
  repo: OrcaRepo,
  fsmonitor: boolean,
  indexPath: string
): Promise<{ rows: PodGitProfileRow[]; snapshot: unknown }> {
  return withLocalGitCapabilityCacheForExecution({ cwd: repo.path }, async (capabilities) => {
    const host = createLocalGitPerformanceConfigHost(repo.path, capabilities, 'background')
    const snapshot = await readGitPerformanceConfigSnapshot(host)
    const open = new Set(listUnconfiguredGitPerformanceConfigKeys(snapshot))
    const plan = planGitPerformanceConfig(
      await collectFacts(host, open, fsmonitor, indexPath),
      snapshot
    )
    const rows = plan.map((entry): PodGitProfileRow => {
      const current = snapshot.effective.get(entry.key.toLowerCase())?.at(-1) ?? null
      if (entry.action === 'skip') {
        const theirs =
          entry.reason === 'set-by-user' || entry.reason === 'set-by-feature-many-files'
        return {
          key: entry.key,
          value: current ?? '',
          action: theirs ? 'user' : 'skip',
          reason: entry.reason,
          current,
          source: 'orca'
        }
      }
      return {
        key: entry.key,
        value: entry.value,
        action: entry.action,
        reason: entry.action === 'keep' ? 'already-set' : 'orca-recommended',
        current,
        source: 'orca'
      }
    })
    // What the plan read, for its fingerprint; git prints config in a stable order.
    return { rows, snapshot: [[...snapshot.local], [...snapshot.effective]] }
  })
}

/** Sets Orca's keys through Orca's runner; the keys it set this time, for the undo record. */
export async function applyOrcaTuning(repo: OrcaRepo, fsmonitor: boolean): Promise<string[]> {
  const outcome = await runRepoPerformanceConfig(repo, 'apply', {
    fsmonitor,
    admissionTier: 'background'
  })
  if (outcome.status !== 'ok') {
    throw new Error(outcome.message ?? `Orca's git tuning is unavailable (${outcome.reason})`)
  }
  return (outcome.plan ?? []).filter((entry) => entry.action === 'set').map((entry) => entry.key)
}

/** Removes only these keys, and only where they still hold the value Orca recorded. */
export async function revertOrcaTuning(repo: OrcaRepo, keys: readonly string[]): Promise<string[]> {
  const owned: GitPerformanceConfigKey[] = keys.filter(isGitPerformanceConfigKey)
  if (owned.length === 0) {
    return []
  }
  const outcome = await runRepoPerformanceConfig(repo, 'revert', {
    keys: owned,
    admissionTier: 'background'
  })
  return outcome.status === 'ok' ? (outcome.reverted ?? []) : []
}
