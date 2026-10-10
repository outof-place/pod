// Fork-only (Pod): the direct lane's view of the daemon. Main passes the peer-identity addon's path
// in POD_PEER_IDENTITY_ADDON when it spawns the daemon; without it the lane admits no one.
import { dirname, join } from 'node:path'
import { loadPodPeerVerifier } from '../../pod/ui-host/pod-peer-identity'
import type { DaemonFileLog } from '../daemon-file-log'
import type { DaemonSessionAttachments } from '../daemon-session-attachments'
import type { DaemonStreamDataBatcher } from '../daemon-stream-data-batcher'
import type { TerminalHost } from '../terminal-host'
import { PodLaneServer } from './pod-lane-server'
import { livePodLaneSession } from './pod-lane-sessions'

export { isPodLaneRequest } from './pod-lane-requests'
export type { PodLaneServer } from './pod-lane-server'

export function podLaneSocketPath(daemonSocketPath: string, protocolVersion: number): string {
  return join(dirname(daemonSocketPath), `pod-lane-v${protocolVersion}.sock`)
}

export function createDaemonPodLaneServer(deps: {
  socketPath: string
  protocolVersion: number
  host: Pick<TerminalHost, 'write'>
  attachments: DaemonSessionAttachments
  streamDataBatcher: DaemonStreamDataBatcher
  log: DaemonFileLog
}): PodLaneServer {
  const addonPath = process.env.POD_PEER_IDENTITY_ADDON
  // Why: the daemon's env seeds its PTYs'; the path is the daemon's business only.
  delete process.env.POD_PEER_IDENTITY_ADDON
  const { host, attachments, streamDataBatcher, log } = deps
  return new PodLaneServer({
    socketPath: podLaneSocketPath(deps.socketPath, deps.protocolVersion),
    verifyPeer: addonPath ? loadPodPeerVerifier(addonPath) : null,
    ports: {
      attachedClientId: (sessionId) => attachments.clientIdForSession(sessionId),
      attachTap: (sessionId, tap) =>
        livePodLaneSession(sessionId)?.attachClient({
          onData: (data) => tap.onData(data),
          onExit: (code) => tap.onExit(code),
          podLane: true
        }) ?? null,
      detachTap: (sessionId, token) => livePodLaneSession(sessionId)?.detachClient(token),
      write: (sessionId, data) => host.write(sessionId, data),
      recordInput: (sessionId) => attachments.recordInput(sessionId),
      enqueueEvent: (clientId, sessionId, event) =>
        streamDataBatcher.enqueueControlEvent(clientId, sessionId, event),
      flush: (clientId) => streamDataBatcher.flush(clientId),
      log: (event, details) => log.log(event, details)
    }
  })
}
