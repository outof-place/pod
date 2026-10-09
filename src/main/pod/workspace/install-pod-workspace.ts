import { homedir } from 'node:os'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { Repo } from '../../../shared/repo-types'
import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { setDefaultCreateProjectParentOverride } from '../../ipc/repos/repo-creation-handlers'
import { isPodWorkspaceEnabled } from './pod-workspace-flag'
import { workspaceCreateProjectParent } from './workspace-clone-destination'
import { registerWorkspaceIpc } from './workspace-ipc'
import {
  notifyPodWorkspaceWorktreeLifecycle,
  setPodWorkspaceWorktreeLifecycleHandler,
  type WorkspaceWorktreeLifecycleEvent
} from './workspace-lifecycle-hook'
import { createPostCreateHygiene } from './workspace-post-create'
import { createWorkspaceGitRunner } from './workspace-repo-inventory'
import {
  computeWorkspaceRoots,
  primeWorkspaceRoots,
  syncWorkspaceRoots
} from './workspace-root-events'
import {
  isLocalGitRepo,
  isPathInsideWorkspaceRoot,
  resolveWorkspaceRoot,
  workspaceRootSetting
} from './workspace-root-path'
import {
  isInsideICloudDrive,
  readDesktopDocumentsSync,
  type DesktopDocumentsSync
} from './workspace-root-validation'
import { createWorkspaceStatusService } from './workspace-status'
import { createWorkspaceToolRunner } from './workspace-tool-runner'

const FINDER_SYNC_CACHE_MS = 10 * 60 * 1000
const ROOT_SETTING_KEYS = new Set<string>(['podWorkspaceRoot', 'experimentalPodWorkspace'])

type PodWorkspaceStore = {
  getSettings(): GlobalSettings
  getRepos(): Repo[]
  onSettingsChanged(listener: (updates: Partial<GlobalSettings>) => void): () => void
}

type PodWorkspaceRuntime = {
  onClientEvent(
    listener: (event: RuntimeClientEvent) => void,
    options?: { consumesTerminalSideEffects?: boolean }
  ): () => void
  onWorktreeLifecycle(listener: (event: WorkspaceWorktreeLifecycleEvent) => void): () => void
}

let installed = false

/** Idempotent. Registers listeners and IPC only: nothing here touches disk or spawns at startup. */
export function installPodWorkspace(store: PodWorkspaceStore, runtime: PodWorkspaceRuntime): void {
  if (installed) {
    return
  }
  installed = true
  const home = homedir()
  const isEnabled = (): boolean => isPodWorkspaceEnabled(store.getSettings())
  const run = createWorkspaceToolRunner()
  let finderSync: { value: DesktopDocumentsSync; at: number } | null = null
  const validation = {
    home,
    readDesktopDocumentsSync: async (): Promise<DesktopDocumentsSync> => {
      if (finderSync && Date.now() - finderSync.at < FINDER_SYNC_CACHE_MS) {
        return finderSync.value
      }
      finderSync = { value: await readDesktopDocumentsSync(run), at: Date.now() }
      return finderSync.value
    }
  }
  const status = createWorkspaceStatusService({
    store,
    run,
    git: createWorkspaceGitRunner(),
    home,
    validation
  })
  // Other platforms still answer the renderer's gate query (false), and do nothing else.
  registerWorkspaceIpc({
    isEnabled,
    getRootSetting: () => workspaceRootSetting(store.getSettings()),
    validation,
    status
  })
  if (process.platform !== 'darwin') {
    return
  }

  setDefaultCreateProjectParentOverride(() => {
    if (!isEnabled()) {
      return null
    }
    const root = resolveWorkspaceRoot(store.getSettings(), home)
    // Synchronous seam: only the iCloud Drive refusal is cheap enough to check here.
    return isInsideICloudDrive(root, home) ? null : workspaceCreateProjectParent(root)
  })

  const currentRoots = (): Map<string, string> =>
    computeWorkspaceRoots(
      store.getRepos(),
      resolveWorkspaceRoot(store.getSettings(), home),
      isEnabled()
    )
  primeWorkspaceRoots(currentRoots())
  runtime.onClientEvent(
    (event) => {
      if (event.type === 'reposChanged') {
        syncWorkspaceRoots(currentRoots())
      }
    },
    { consumesTerminalSideEffects: false }
  )
  store.onSettingsChanged((updates) => {
    if (Object.keys(updates).some((key) => ROOT_SETTING_KEYS.has(key))) {
      syncWorkspaceRoots(currentRoots())
    }
  })

  const postCreate = createPostCreateHygiene({
    exclude: (checkoutPath) => status.excludeCheckoutBuildFolders(checkoutPath)
  })
  setPodWorkspaceWorktreeLifecycleHandler((event) => {
    if (event.kind === 'removed') {
      postCreate.checkoutRemoved(event.path)
      return
    }
    const repoId = getRepoIdFromWorktreeId(event.worktreeId)
    const repo = store.getRepos().find((candidate) => candidate.id === repoId)
    const root = resolveWorkspaceRoot(store.getSettings(), home)
    if (isEnabled() && repo && isLocalGitRepo(repo) && isPathInsideWorkspaceRoot(repo.path, root)) {
      postCreate.checkoutCreated(event.path)
    }
  })
  runtime.onWorktreeLifecycle(notifyPodWorkspaceWorktreeLifecycle)
}
