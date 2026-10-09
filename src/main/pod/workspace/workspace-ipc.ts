import { ipcMain } from 'electron'
import { POD_WORKSPACE_IPC } from '../../../shared/pod-workspace-types'
import type { PodWorkspaceRootValidation } from '../../../shared/pod-workspace-types'
import { workspaceCloneParent } from './workspace-clone-destination'
import { hasBlockingRootIssue, validateWorkspaceRoot } from './workspace-root-validation'
import type { RootValidationDeps } from './workspace-root-validation'

export type WorkspaceIpcDeps = {
  isEnabled: () => boolean
  getRootSetting: () => string
  validation: RootValidationDeps
}

export function registerWorkspaceIpc(deps: WorkspaceIpcDeps): void {
  ipcMain.handle(POD_WORKSPACE_IPC.enabled, (): boolean => deps.isEnabled())

  ipcMain.handle(
    POD_WORKSPACE_IPC.validateRoot,
    (_event, value: unknown): Promise<PodWorkspaceRootValidation> =>
      validateWorkspaceRoot(typeof value === 'string' ? value : '', deps.validation)
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
