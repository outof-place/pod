import { homedir } from 'node:os'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { setDefaultCreateProjectParentOverride } from '../../ipc/repos/repo-creation-handlers'
import { isPodWorkspaceEnabled } from './pod-workspace-flag'
import { workspaceCreateProjectParent } from './workspace-clone-destination'
import { registerWorkspaceIpc } from './workspace-ipc'
import { resolveWorkspaceRoot, workspaceRootSetting } from './workspace-root-path'
import {
  isInsideICloudDrive,
  readDesktopDocumentsSync,
  type DesktopDocumentsSync
} from './workspace-root-validation'
import { createWorkspaceToolRunner } from './workspace-tool-runner'

const FINDER_SYNC_CACHE_MS = 10 * 60 * 1000

type PodWorkspaceStore = {
  getSettings(): GlobalSettings
}

let installed = false

/** Idempotent. Registers IPC and seams only: nothing here touches disk or spawns at startup. */
export function installPodWorkspace(store: PodWorkspaceStore): void {
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
  // Other platforms still answer the renderer's gate query (false), and do nothing else.
  registerWorkspaceIpc({
    isEnabled,
    getRootSetting: () => workspaceRootSetting(store.getSettings()),
    validation
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
}
