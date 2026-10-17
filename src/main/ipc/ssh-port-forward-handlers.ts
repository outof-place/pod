import { ipcMain } from 'electron'
import type { EnrichedDetectedPort, PortForwardEntry } from '../../shared/ssh-types'
import { POD_SSH_NOT_CONNECTED_CODE } from '../../shared/pod-ssh-port-events'
import {
  enrichSshForwardEntries,
  getWorktreeIdsForConnection
} from '../ports/ssh-advertised-url-enrichment'
import { activeSessions } from './ssh-active-relay-sessions'
import {
  connectionManager,
  getCurrentMainWindow,
  persistedStore,
  portForwardManager
} from './ssh-ipc-context'
import { persistPortForwards } from './ssh-port-forward-persistence'
import { broadcastPortForwards, enrichDetected } from './ssh-renderer-broadcast'

export type SshPortForwardInput = {
  targetId: string
  localPort: number
  remoteHost: string
  remotePort: number
  label?: string
}

export function registerSshPortForwardHandlers(): void {
  ipcMain.handle('ssh:addPortForward', (_event, args: SshPortForwardInput) =>
    addSshPortForward(args)
  )
  ipcMain.handle('ssh:updatePortForward', (_event, args: SshPortForwardInput & { id: string }) =>
    updateSshPortForward(args)
  )
  ipcMain.handle('ssh:removePortForward', (_event, args: { id: string }) =>
    removeSshPortForward(args.id)
  )
  ipcMain.handle('ssh:listPortForwards', (_event, args?: { targetId?: string }) =>
    listSshPortForwards(args?.targetId)
  )
  ipcMain.handle('ssh:listDetectedPorts', (_event, args: { targetId: string }) =>
    listSshDetectedPorts(args.targetId)
  )
}

// Fork-only (Pod): the handlers' bodies are exported for PodNative's ssh.*PortForward* RPCs
// (install-pod-ssh-port-forwards.ts).
function connectionFor(targetId: string) {
  const conn = connectionManager!.getConnection(targetId)
  if (!conn) {
    // The code reaches RPC clients only; the desktop reads the message, as before.
    throw Object.assign(new Error(`SSH connection "${targetId}" not found`), {
      code: POD_SSH_NOT_CONNECTED_CODE
    })
  }
  return conn
}

export async function addSshPortForward(args: SshPortForwardInput): Promise<PortForwardEntry> {
  const conn = connectionFor(args.targetId)
  const entry = await portForwardManager!.addForward(
    args.targetId,
    conn,
    args.localPort,
    args.remoteHost,
    args.remotePort,
    args.label
  )
  persistPortForwards(args.targetId)
  broadcastPortForwards(getCurrentMainWindow, args.targetId)
  return entry
}

export async function updateSshPortForward(
  args: SshPortForwardInput & { id: string }
): Promise<PortForwardEntry> {
  const conn = connectionFor(args.targetId)
  try {
    const entry = await portForwardManager!.updateForward(
      args.id,
      conn,
      args.localPort,
      args.remoteHost,
      args.remotePort,
      args.label
    )
    persistPortForwards(entry.connectionId)
    broadcastPortForwards(getCurrentMainWindow, entry.connectionId)
    return entry
  } catch (err) {
    // Why: edit/rollback may have failed, so resync renderer to actual runtime state.
    persistPortForwards(args.targetId)
    broadcastPortForwards(getCurrentMainWindow, args.targetId)
    throw err
  }
}

export async function removeSshPortForward(id: string): Promise<PortForwardEntry | null> {
  const removed = await portForwardManager!.removeForwardAndWait(id)
  if (removed) {
    persistPortForwards(removed.connectionId)
    broadcastPortForwards(getCurrentMainWindow, removed.connectionId)
  }
  return removed
}

export function listSshPortForwards(targetId?: string): PortForwardEntry[] {
  const all = portForwardManager!.listForwards(targetId)
  if (!persistedStore || !targetId) {
    // Why: cross-target entries can't be mapped to worktrees in one call, so serve the raw list.
    return all
  }
  return enrichSshForwardEntries(all, getWorktreeIdsForConnection(persistedStore, targetId))
}

export function listSshDetectedPorts(targetId: string): EnrichedDetectedPort[] {
  const session = activeSessions.get(targetId)
  const ports = session?.getPortScanner()?.getDetectedPorts(targetId) ?? []
  return enrichDetected(targetId, ports)
}
