// Fork-only (Pod): SSH port forwarding for runtime RPC, installed by the IPC layer so the runtime's
// module graph stays free of Electron (config/runtime-electron-baseline.txt), plus the change events
// the desktop broadcasts to its window, for PodNative's stream.
import type { PodSshPortEvent } from '../../../shared/pod-ssh-port-events'
import type { EnrichedDetectedPort, PortForwardEntry } from '../../../shared/ssh-types'

export type PodSshPortForwardInput = {
  targetId: string
  localPort: number
  remoteHost: string
  remotePort: number
  label?: string
}

/** The same calls the desktop's IPC handlers make (ssh-port-forward-handlers.ts). */
export type PodSshPortForwardOps = {
  list(targetId?: string): PortForwardEntry[]
  add(input: PodSshPortForwardInput): Promise<PortForwardEntry>
  update(input: PodSshPortForwardInput & { id: string }): Promise<PortForwardEntry>
  remove(id: string): Promise<PortForwardEntry | null>
  listDetected(targetId: string): EnrichedDetectedPort[]
}

let installed: PodSshPortForwardOps | null = null

export function setPodSshPortForwardOps(ops: PodSshPortForwardOps | null): void {
  installed = ops
}

/** Null on a host whose SSH layer never registered (orcad). */
export function getPodSshPortForwardOps(): PodSshPortForwardOps | null {
  return installed
}

const listeners = new Set<(event: PodSshPortEvent) => void>()

/** `event` is built only when someone listens: enriching a host's forwards is not free. */
export function publishPodSshPortEvent(event: () => PodSshPortEvent): void {
  if (listeners.size === 0) {
    return
  }
  const built = event()
  for (const listener of listeners) {
    try {
      listener(built)
    } catch (error) {
      console.error('[ssh] a port event listener failed', error)
    }
  }
}

export function subscribePodSshPortEvents(listener: (event: PodSshPortEvent) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
