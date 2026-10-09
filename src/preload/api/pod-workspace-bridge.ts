import { ipcRenderer } from 'electron'
import { POD_WORKSPACE_IPC } from '../../shared/pod-workspace-types'
import type { PreloadApi } from '../api-types'

export const podWorkspaceApi = {
  isEnabled: () => ipcRenderer.invoke(POD_WORKSPACE_IPC.enabled),
  validateRoot: (root) => ipcRenderer.invoke(POD_WORKSPACE_IPC.validateRoot, root),
  getCloneDestination: (url) => ipcRenderer.invoke(POD_WORKSPACE_IPC.cloneDestination, url)
} satisfies PreloadApi['podWorkspace']
