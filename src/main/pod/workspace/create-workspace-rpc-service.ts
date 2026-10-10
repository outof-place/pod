import type { Repo } from '../../../shared/repo-types'
import { createWorkspaceAdopt } from './workspace-adopt'
import { resolveWorkspaceCloneDestination } from './workspace-clone-parent'
import { createWorkspaceGitExec } from './workspace-git-exec'
import { createWorkspaceGitProfile } from './workspace-git-profile'
import { createWorkspaceJournal, workspaceJournalPath } from './workspace-journal'
import { createWorkspacePlanStore, fingerprintOf } from './workspace-plan-store'
import { createNativeProcessCwdReader } from './workspace-process-cwds'
import { validateWorkspaceRoot, type RootValidationDeps } from './workspace-root-validation'
import { isLocalGitRepo, resolveWorkspaceRoot, workspaceRootSetting } from './workspace-root-path'
import type { PodWorkspaceRpcService } from './workspace-rpc-service'
import { openSpotlightSettings } from './workspace-spotlight-settings'
import type { WorkspaceStatusService } from './workspace-status'
import { createWorkspaceTidyActions } from './workspace-tidy-actions'
import { scanWorkspaceTidy } from './workspace-tidy-scan'
import type { WorkspaceStrayStore } from './workspace-tidy-strays'
import { createWorkspaceTrash } from './workspace-trash'

export type WorkspaceRpcServiceDeps = {
  store: WorkspaceStrayStore & { getRepos(): Repo[] }
  isEnabled: () => boolean
  status: WorkspaceStatusService
  validation: RootValidationDeps
  home: string
  userDataDir: string
  /** The system's Trash, for a folder on another volume than the home folder. */
  osTrash: (path: string) => Promise<void>
  onBackgroundDone?: (repoId: string, message: string) => void
}

export type PodWorkspaceServices = PodWorkspaceRpcService & {
  /** A new clone into the root gets the default profile: Orca's and Pod's measured keys, no opt-ins. */
  tuneNewClone(repoId: string): Promise<void>
}

export function createPodWorkspaceRpcService(deps: WorkspaceRpcServiceDeps): PodWorkspaceServices {
  const git = createWorkspaceGitExec()
  const processes = createNativeProcessCwdReader()
  const journal = createWorkspaceJournal(workspaceJournalPath(deps.userDataDir))
  const plans = createWorkspacePlanStore()
  const trash = createWorkspaceTrash(deps.home, deps.osTrash)
  const localRepos = (): Repo[] => deps.store.getRepos().filter(isLocalGitRepo)
  const getRepo = (repoId: string): Repo | undefined =>
    localRepos().find((repo) => repo.id === repoId)
  const scanDeps = { git, processes, journal, plans, store: deps.store }
  const profile = createWorkspaceGitProfile({
    git,
    home: deps.home,
    journal,
    plans,
    getRepo,
    onBackgroundDone: deps.onBackgroundDone
  })
  const adopt = createWorkspaceAdopt({
    git,
    journal,
    plans,
    processes,
    getRepo,
    root: () => resolveWorkspaceRoot(deps.store.getSettings(), deps.home),
    home: deps.home
  })
  const cloneDeps = {
    isEnabled: deps.isEnabled,
    getRootSetting: () => workspaceRootSetting(deps.store.getSettings()),
    validation: deps.validation
  }
  // What an Exclude click covers: the build folders the status listed as not yet excluded.
  const excludeFingerprint = (missing: readonly string[]): string =>
    fingerprintOf([...missing].sort())

  return {
    tuneNewClone: async (repoId) => {
      const plan = await profile.plan(repoId)
      if (plan.pending > 0) {
        await profile.apply(plan.planId)
      }
    },
    isEnabled: deps.isEnabled,
    status: async (refresh) => {
      const status = await deps.status.getStatus({ refresh })
      const fingerprints = new Map([['exclude', excludeFingerprint(status.timeMachine.missing)]])
      return { ...status, excludePlan: plans.issue('status', fingerprints) }
    },
    validateRoot: (value) => validateWorkspaceRoot(value, deps.validation),
    excludeBuildFolders: async (planId) => {
      plans.expected(planId, 'status', 'exclude')
      const fresh = await deps.status.getStatus({ refresh: true })
      plans.verify(planId, 'status', 'exclude', excludeFingerprint(fresh.timeMachine.missing))
      plans.consume(planId)
      return deps.status.excludeBuildFolders()
    },
    openSpotlightSettings,
    cloneDestination: (url) => resolveWorkspaceCloneDestination(cloneDeps, url),
    tidyScan: (repoIds) =>
      scanWorkspaceTidy(
        scanDeps,
        localRepos().filter((repo) => !repoIds || repoIds.includes(repo.id))
      ),
    tidyApply: (request, removeWorktree) =>
      createWorkspaceTidyActions({ ...scanDeps, getRepo, removeWorktree, trash }).run(request),
    gitProfile: (request) =>
      request.action === 'plan'
        ? profile.plan(request.repoId)
        : request.action === 'apply'
          ? profile.apply(request.planId, request.optIns)
          : profile.undo(request.planId, request.tuneId),
    adopt: (request) => {
      switch (request.action) {
        case 'plan':
          return adopt.plan(request.repoId)
        case 'apply':
          return adopt.apply(request.planId, request.acknowledged)
        case 'plan-undo':
          return adopt.planUndo(request.recordId)
        case 'undo':
          return adopt.undo(request.planId)
      }
    }
  }
}
