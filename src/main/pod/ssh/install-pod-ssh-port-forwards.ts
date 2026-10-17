// Fork-only (Pod): hands SSH port forwarding's IPC operations to the runtime RPC (pod-ssh-port-forwards.ts).
import {
  addSshPortForward,
  listSshDetectedPorts,
  listSshPortForwards,
  removeSshPortForward,
  updateSshPortForward
} from '../../ipc/ssh-port-forward-handlers'
import { setPodSshPortForwardOps } from './pod-ssh-port-forwards'

/** Called where the SSH IPC handlers register (registerSshHandlers), window or headless. */
export function installPodSshPortForwards(): void {
  setPodSshPortForwardOps({
    list: listSshPortForwards,
    add: addSshPortForward,
    update: updateSshPortForward,
    remove: removeSshPortForward,
    listDetected: listSshDetectedPorts
  })
}
