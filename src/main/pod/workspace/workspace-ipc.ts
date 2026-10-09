import { ipcMain, shell } from 'electron'
import { POD_WORKSPACE_IPC } from '../../../shared/pod-workspace-types'
import type {
  PodWorkspaceExcludeResult,
  PodWorkspaceRootValidation,
  PodWorkspaceStatus
} from '../../../shared/pod-workspace-types'
import { workspaceCloneParent } from './workspace-clone-destination'
import { hasBlockingRootIssue, validateWorkspaceRoot } from './workspace-root-validation'
import type { RootValidationDeps } from './workspace-root-validation'
import type { WorkspaceStatusService } from './workspace-status'

// Search Privacy is a sheet inside the Spotlight pane, which has no deep link of its own.
const SPOTLIGHT_SETTINGS_URLS = [
  'x-apple.systempreferences:com.apple.Spotlight-Settings.extension',
  'x-apple.systempreferences:com.apple.preference.spotlight'
] as const
const SYSTEM_SETTINGS_APP = '/System/Applications/System Settings.app'

export type WorkspaceIpcDeps = {
  isEnabled: () => boolean
  getRootSetting: () => string
  validation: RootValidationDeps
  status: WorkspaceStatusService
}

async function openSpotlightSettings(): Promise<boolean> {
  for (const url of SPOTLIGHT_SETTINGS_URLS) {
    try {
      await shell.openExternal(url)
      return true
    } catch {
      // Older or newer macOS may only know one of the two pane ids.
    }
  }
  return (await shell.openPath(SYSTEM_SETTINGS_APP)) === ''
}

export function registerWorkspaceIpc(deps: WorkspaceIpcDeps): void {
  ipcMain.handle(POD_WORKSPACE_IPC.enabled, (): boolean => deps.isEnabled())

  ipcMain.handle(
    POD_WORKSPACE_IPC.status,
    (_event, args: unknown): Promise<PodWorkspaceStatus> | null => {
      if (!deps.isEnabled()) {
        return null
      }
      const refresh =
        typeof args === 'object' && args !== null && Reflect.get(args, 'refresh') === true
      return deps.status.getStatus({ refresh })
    }
  )

  ipcMain.handle(
    POD_WORKSPACE_IPC.validateRoot,
    (_event, value: unknown): Promise<PodWorkspaceRootValidation> =>
      validateWorkspaceRoot(typeof value === 'string' ? value : '', deps.validation)
  )

  ipcMain.handle(
    POD_WORKSPACE_IPC.excludeBuildFolders,
    (): Promise<PodWorkspaceExcludeResult> | null =>
      deps.isEnabled() ? deps.status.excludeBuildFolders() : null
  )

  ipcMain.handle(POD_WORKSPACE_IPC.openSpotlightSettings, (): Promise<boolean> | false =>
    deps.isEnabled() ? openSpotlightSettings() : false
  )

  ipcMain.handle(
    POD_WORKSPACE_IPC.cloneDestination,
    async (_event, url: unknown): Promise<string | null> => {
      if (!deps.isEnabled() || typeof url !== 'string') {
        return null
      }
      const validation = await validateWorkspaceRoot(deps.getRootSetting(), deps.validation)
      // Why null on a refused root: Orca's own default is better than a clone into iCloud.
      if (hasBlockingRootIssue(validation) || !validation.root) {
        return null
      }
      // Before a URL is typed the field shows the root itself.
      return url.trim() ? workspaceCloneParent(validation.root, url) : validation.root
    }
  )
}
