import { ipcRenderer } from 'electron'
import { POD_WORKSPACE_IPC } from '../../shared/pod-workspace-types'
import type { PreloadApi } from '../api-types'

export const podWorkspaceApi = {
  isEnabled: () => ipcRenderer.invoke(POD_WORKSPACE_IPC.enabled),
  getStatus: (args) => ipcRenderer.invoke(POD_WORKSPACE_IPC.status, args),
  validateRoot: (root) => ipcRenderer.invoke(POD_WORKSPACE_IPC.validateRoot, root),
  excludeBuildFolders: () => ipcRenderer.invoke(POD_WORKSPACE_IPC.excludeBuildFolders),
  openSpotlightSettings: () => ipcRenderer.invoke(POD_WORKSPACE_IPC.openSpotlightSettings),
  getCloneDestination: (url) => ipcRenderer.invoke(POD_WORKSPACE_IPC.cloneDestination, url)
} satisfies PreloadApi['podWorkspace']
