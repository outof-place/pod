import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { Repo } from '../../../shared/repo-types'
import { getDefaultBaseRefAsync } from '../../git/repo-default-base-ref'
import { createWorkspaceAdopt } from './workspace-adopt'
import { createWorkspaceGitExec } from './workspace-git-exec'
import { createWorkspaceGitProfile } from './workspace-git-profile'
import { createWorkspaceJournal, workspaceJournalPath } from './workspace-journal'
import { createNativeProcessCwdReader } from './workspace-process-cwds'
import { isLocalGitRepo, resolveWorkspaceRoot } from './workspace-root-path'
import type { PodWorkspaceRpcService } from './workspace-rpc-service'
import type { WorkspaceStatusService } from './workspace-status'
import { createWorkspaceTidyActions } from './workspace-tidy-actions'
import { scanWorkspaceTidy } from './workspace-tidy-scan'
import { parseWorktreePorcelainZ } from './workspace-tidy-git'

export type WorkspaceRpcServiceDeps = {
  store: { getSettings(): GlobalSettings; getRepos(): Repo[] }
  isEnabled: () => boolean
  status: WorkspaceStatusService
  home: string
  userDataDir: string
  cloneDestination: (url: string) => Promise<string | null>
  trash: (path: string) => Promise<void>
}

export function createPodWorkspaceRpcService(
  deps: WorkspaceRpcServiceDeps
): PodWorkspaceRpcService {
  const git = createWorkspaceGitExec()
  const processes = createNativeProcessCwdReader()
  const journal = createWorkspaceJournal(workspaceJournalPath(deps.userDataDir))
  const profile = createWorkspaceGitProfile({ git, home: deps.home })
  const localRepos = (): Repo[] => deps.store.getRepos().filter(isLocalGitRepo)
  const getRepo = (repoId: string): Repo | undefined =>
    localRepos().find((repo) => repo.id === repoId)
  const scanDeps = {
    git,
    processes,
    journal,
    defaultBaseRef: async (repo: Repo) =>
      repo.worktreeBaseRef?.trim() || (await getDefaultBaseRefAsync(repo.path))
  }
  const adopt = createWorkspaceAdopt({
    git,
    journal,
    processes,
    getRepo,
    root: () => resolveWorkspaceRoot(deps.store.getSettings(), deps.home),
    home: deps.home
  })
  const repoOrThrow = (repoId: string): Repo => {
    const repo = getRepo(repoId)
    if (!repo) {
      throw new Error('Unknown repository')
    }
    return repo
  }

  return {
    isEnabled: deps.isEnabled,
    status: (refresh) => deps.status.getStatus({ refresh }),
    tidyScan: (repoIds) =>
      scanWorkspaceTidy(
        scanDeps,
        localRepos().filter((repo) => !repoIds || repoIds.includes(repo.id))
      ),
    tidyApply: (action, removeWorktree) =>
      createWorkspaceTidyActions({ ...scanDeps, getRepo, removeWorktree, trash: deps.trash }).run(
        action
      ),
    gitProfile: async (repoId, action) => {
      const repo = repoOrThrow(repoId)
      if (action === 'apply') {
        const written = await profile.apply(repo.path)
        return { written, profile: await profile.plan(repo.path) }
      }
      if (action === 'revert') {
        const list = await git(['worktree', 'list', '--porcelain', '-z'], repo.path)
        const paths = parseWorktreePorcelainZ(list.stdout).map((entry) => entry.path)
        const removed = await profile.revert(repo.path, paths)
        return { removed, profile: await profile.plan(repo.path) }
      }
      return { profile: await profile.plan(repo.path) }
    },
    cloneDestination: deps.cloneDestination,
    adopt: (action) =>
      action.kind === 'plan'
        ? adopt.plan(action.repoId)
        : action.kind === 'apply'
          ? adopt.apply(action.repoId)
          : adopt.undo(action.recordId)
  }
}
