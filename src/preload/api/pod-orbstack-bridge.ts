import { ipcRenderer } from 'electron'
import { POD_ORBSTACK_IPC } from '../../shared/pod-orbstack-types'
import type { PreloadApi } from '../api-types'

export const podOrbstackApi = {
  isEnabled: () => ipcRenderer.invoke(POD_ORBSTACK_IPC.enabled),
  getStatus: () => ipcRenderer.invoke(POD_ORBSTACK_IPC.status),
  createMachine: (args) => ipcRenderer.invoke(POD_ORBSTACK_IPC.createMachine, args),
  removeMachine: (args) => ipcRenderer.invoke(POD_ORBSTACK_IPC.removeMachine, args),
  startMachine: (args) => ipcRenderer.invoke(POD_ORBSTACK_IPC.startMachine, args),
  stopMachine: (args) => ipcRenderer.invoke(POD_ORBSTACK_IPC.stopMachine, args),
  setDockerPin: (args) => ipcRenderer.invoke(POD_ORBSTACK_IPC.setDockerPin, args)
} satisfies PreloadApi['podOrbstack']
