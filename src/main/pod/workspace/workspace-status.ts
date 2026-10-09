import { access } from 'node:fs/promises'
import { join } from 'node:path'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { mapWithConcurrency } from '../../../shared/map-with-concurrency'
import type {
  PodWorkspaceExcludeResult,
  PodWorkspaceIndexStatus,
  PodWorkspaceRepoRow,
  PodWorkspaceSpotlight,
  PodWorkspaceStatus
} from '../../../shared/pod-workspace-types'
import type { Repo } from '../../../shared/repo-types'
import {
  detectSpotlightState,
  excludeMissingBuildDirs,
  readBuildDirExclusions,
  readTimeMachineDestination
} from './workspace-hygiene'
import {
  listTrackedRootFiles,
  readRepoGitInfo,
  type RepoGitInfo,
  type WorkspaceGitRunner
} from './workspace-repo-inventory'
import { getWorkspaceIndexStatusProvider } from './workspace-root-events'
import {
  isLocalGitRepo,
  isPathInsideWorkspaceRoot,
  resolveWorkspaceRoot,
  workspaceRootAliases
} from './workspace-root-path'
import type { RootValidationDeps } from './workspace-root-validation'
import { validateWorkspaceRoot } from './workspace-root-validation'
import type { WorkspaceToolRunner } from './workspace-tool-runner'
import { checkWorkspaceVolume, resolvePnpmStoreDir } from './workspace-volume-checks'

const REPO_CONCURRENCY = 4
const SPOTLIGHT_CACHE_MS = 10 * 60 * 1000
const STORE_DIR_CACHE_MS = 10 * 60 * 1000
const SNAPSHOT_REUSE_MS = 15_000
const INDEX_STATUS_TIMEOUT_MS = 2_000
const STEP_TIMEOUT_MS = 20_000

export type WorkspaceStatusDeps = {
  store: { getSettings(): Pick<GlobalSettings, 'podWorkspaceRoot'>; getRepos(): Repo[] }
  run: WorkspaceToolRunner
  git: WorkspaceGitRunner
  home: string
  validation: Omit<RootValidationDeps, 'home'>
  now?: () => number
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(fallback)
      }
    )
  })
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export function migrationScriptPath(home: string): string {
  return join(home, '.local', 'share', 'pod-migrate', 'migrate.sh')
}

/** On-demand health snapshot: every probe is async, bounded and timed out, never at startup. */
export function createWorkspaceStatusService(deps: WorkspaceStatusDeps) {
  const now = deps.now ?? Date.now
  let spotlightCache: { key: string; value: PodWorkspaceSpotlight } | null = null
  let storeDirCache: { value: string; at: number } | null = null
  let snapshot: { value: PodWorkspaceStatus; at: number } | null = null
  let inflight: Promise<PodWorkspaceStatus> | null = null

  const reposUnderRoot = (root: string): Repo[] =>
    deps.store
      .getRepos()
      .filter((repo) => isLocalGitRepo(repo) && isPathInsideWorkspaceRoot(repo.path, root))

  const pnpmStoreDir = async (): Promise<string> => {
    if (storeDirCache && now() - storeDirCache.at < STORE_DIR_CACHE_MS) {
      return storeDirCache.value
    }
    const value = await resolvePnpmStoreDir(deps.run, deps.home)
    storeDirCache = { value, at: now() }
    return value
  }

  const spotlight = async (root: string, repos: Repo[], refresh: boolean) => {
    const key = `${root}\n${repos.map((repo) => repo.path).join('\n')}`
    const cached = spotlightCache
    if (!refresh && cached?.key === key && now() - cached.value.checkedAt < SPOTLIGHT_CACHE_MS) {
      return cached.value
    }
    const value = await detectSpotlightState({
      run: deps.run,
      repoPaths: repos.map((repo) => repo.path),
      listTrackedRootFiles: (repoPath, names) => listTrackedRootFiles(repoPath, names, deps.git),
      now: now()
    })
    spotlightCache = { key, value }
    return value
  }

  const indexStatus = async (path: string): Promise<PodWorkspaceIndexStatus | null> => {
    const provider = getWorkspaceIndexStatusProvider()
    return provider ? withTimeout(provider(path), INDEX_STATUS_TIMEOUT_MS, null) : null
  }

  const checkoutPaths = (repos: Repo[], infos: RepoGitInfo[]): string[] => [
    ...new Set(repos.flatMap((repo, index) => infos[index].worktreePaths ?? [repo.path]))
  ]

  const readInfos = (repos: Repo[]): Promise<RepoGitInfo[]> =>
    mapWithConcurrency(repos, REPO_CONCURRENCY, (repo) => readRepoGitInfo(repo.path, deps.git))

  const compute = async (refresh: boolean): Promise<PodWorkspaceStatus> => {
    const settings = deps.store.getSettings()
    const root = resolveWorkspaceRoot(settings, deps.home)
    const localRepos = deps.store.getRepos().filter(isLocalGitRepo)
    const inside = localRepos.filter((repo) => isPathInsideWorkspaceRoot(repo.path, root))
    const [validation, rootExists, volume, infos, destination, spotlightState, scriptExists] =
      await Promise.all([
        validateWorkspaceRoot(root, { ...deps.validation, home: deps.home }),
        exists(root),
        pnpmStoreDir().then((storeDir) =>
          checkWorkspaceVolume(root, { home: deps.home, pnpmStoreDir: storeDir })
        ),
        readInfos(inside),
        withTimeout(readTimeMachineDestination(deps.run), STEP_TIMEOUT_MS, 'unknown' as const),
        withTimeout(spotlight(root, inside, refresh), STEP_TIMEOUT_MS, {
          state: 'unknown' as const,
          reason: 'error' as const,
          checkedAt: now()
        }),
        exists(migrationScriptPath(deps.home))
      ])
    const [exclusions, indexes] = await Promise.all([
      withTimeout(readBuildDirExclusions(deps.run, checkoutPaths(inside, infos)), STEP_TIMEOUT_MS, {
        excluded: [],
        missing: []
      }),
      mapWithConcurrency(inside, REPO_CONCURRENCY, (repo) => indexStatus(repo.path))
    ])
    const repos: PodWorkspaceRepoRow[] = inside.map((repo, index) => ({
      repoId: repo.id,
      path: repo.path,
      displayName: repo.displayName,
      branch: infos[index].branch,
      worktreeCount: infos[index].worktreePaths?.length ?? null,
      gitTuning: infos[index].gitTuning,
      index: indexes[index]
    }))
    return {
      root,
      rootAliases: workspaceRootAliases(root),
      rootExists,
      validation,
      volume,
      spotlight: spotlightState,
      timeMachine: { destination, ...exclusions },
      indexConnected: getWorkspaceIndexStatusProvider() !== null,
      repos,
      outsideRepos: localRepos
        .filter((repo) => !isPathInsideWorkspaceRoot(repo.path, root))
        .map((repo) => ({ repoId: repo.id, path: repo.path, displayName: repo.displayName })),
      migrationScript: { path: migrationScriptPath(deps.home), exists: scriptExists },
      generatedAt: now()
    }
  }

  return {
    getStatus(options: { refresh?: boolean } = {}): Promise<PodWorkspaceStatus> {
      const refresh = options.refresh === true
      if (!refresh && snapshot && now() - snapshot.at < SNAPSHOT_REUSE_MS) {
        return Promise.resolve(snapshot.value)
      }
      // Why coalesce: a double click or two windows must not double every git and tmutil spawn.
      if (inflight) {
        return inflight
      }
      inflight = compute(refresh)
        .then((value) => {
          snapshot = { value, at: now() }
          return value
        })
        .finally(() => {
          inflight = null
        })
      return inflight
    },

    async excludeBuildFolders(): Promise<PodWorkspaceExcludeResult> {
      const root = resolveWorkspaceRoot(deps.store.getSettings(), deps.home)
      const repos = reposUnderRoot(root)
      const infos = await readInfos(repos)
      const [result, destination] = await Promise.all([
        excludeMissingBuildDirs(deps.run, checkoutPaths(repos, infos)),
        readTimeMachineDestination(deps.run)
      ])
      snapshot = null
      return { excluded: result.excluded.length, failed: result.failed, destination }
    },

    /** One checkout, as after a worktree create; no git calls needed. */
    async excludeCheckoutBuildFolders(checkoutPath: string): Promise<void> {
      await excludeMissingBuildDirs(deps.run, [checkoutPath])
      snapshot = null
    }
  }
}

export type WorkspaceStatusService = ReturnType<typeof createWorkspaceStatusService>
