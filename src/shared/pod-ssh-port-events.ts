// Fork-only (Pod): SSH port forwarding for runtime RPC clients, the desktop's ssh:*PortForward* IPC
// and its ssh:port-forwards-changed / ssh:detected-ports-changed broadcasts.
import type { EnrichedDetectedPort, PortForwardEntry } from './ssh-types'

/** A port forward call on a host that is not connected (the desktop shows the same message). */
export const POD_SSH_NOT_CONNECTED_CODE = 'ssh_not_connected' as const

/** A host's forwards after any add, edit, removal or close, enriched as ssh.listPortForwards is. */
export type PodSshPortForwardsChangedEvent = {
  type: 'sshPortForwardsChanged'
  targetId: string
  forwards: PortForwardEntry[]
}

/** The ports the host's relay found listening, after each scan that changed them. */
export type PodSshDetectedPortsChangedEvent = {
  type: 'sshDetectedPortsChanged'
  targetId: string
  ports: EnrichedDetectedPort[]
}

export type PodSshPortEvent = PodSshPortForwardsChangedEvent | PodSshDetectedPortsChangedEvent
