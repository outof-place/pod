// Fork-only (Pod): the daemon's direct-lane socket. It sits next to the daemon socket (0700 dir),
// is 0600, and admits only PodNative signed by Pod's team, checked by audit token before a byte is
// read; then a one-shot grant main asked for. Kill switch: POD_TERMINAL_DIRECT_LANE=0.
import { chmod, lstat, unlink } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import {
  POD_LANE_MAX_HELLO_BYTES,
  POD_LANE_MAX_INPUT_BYTES,
  POD_LANE_PROTOCOL_VERSION,
  PodLaneClientFrame,
  PodLaneFrameReader,
  type PodLaneFrame
} from '../../../shared/pod-terminal-lane-protocol'
import type { PodPeerVerifier } from '../../pod/ui-host/pod-peer-identity'
import { PodLaneConnection, type PodLanePorts } from './pod-lane-connection'
import { PodLaneGrants } from './pod-lane-grants'
import type { PodLaneRequest } from './pod-lane-requests'

const HELLO_TIMEOUT_MS = 2_000
const FENCE_HOLD_TIMEOUT_MS = 2_000
const MAX_BUFFERED_OUTPUT_BYTES = 8 * 1024 * 1024
/** sockaddr_un.sun_path is 104 bytes on macOS. */
const MAX_SOCKET_PATH_BYTES = 103

export function isPodLaneDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.POD_TERMINAL_DIRECT_LANE === '0'
}

export type PodLaneServerOptions = {
  socketPath: string
  verifyPeer: PodPeerVerifier | null
  ports: PodLanePorts
  grants?: PodLaneGrants
  maxBufferedBytes?: number
  holdTimeoutMs?: number
  helloTimeoutMs?: number
}

export class PodLaneServer {
  private server: Server | null = null
  private listening = false
  private readonly grants: PodLaneGrants
  private readonly lanesById = new Map<string, PodLaneConnection>()
  private readonly laneBySession = new Map<string, PodLaneConnection>()
  private readonly pending = new Set<Socket>()

  constructor(private readonly options: PodLaneServerOptions) {
    this.grants = options.grants ?? new PodLaneGrants()
  }

  /** False, with nothing listening, when the lane can't be offered safely here. */
  async start(): Promise<boolean> {
    const { socketPath, verifyPeer, ports } = this.options
    const unavailable = (reason: string): boolean => {
      ports.log('pod-lane-unavailable', { reason })
      return false
    }
    if (process.platform !== 'darwin' || isPodLaneDisabledByEnv()) {
      return false
    }
    if (!verifyPeer) {
      return unavailable('no peer identity check')
    }
    if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
      return unavailable('socket path too long')
    }
    if (!(await isPrivateDirectory(socketPath))) {
      return unavailable('socket directory is not private')
    }
    await unlinkStaleSocket(socketPath)
    const server = createServer((socket) => this.accept(socket))
    this.server = server
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(socketPath, () => {
          server.off('error', reject)
          resolve()
        })
      })
      await chmod(socketPath, 0o600)
    } catch (error) {
      server.close()
      this.server = null
      return unavailable(error instanceof Error ? error.message : String(error))
    }
    server.on('error', (error) => ports.log('pod-lane-server-error', { error: error.message }))
    this.listening = true
    return true
  }

  async close(): Promise<void> {
    for (const lane of Array.from(this.lanesById.values())) {
      lane.close('daemon-shutdown')
    }
    for (const socket of this.pending) {
      socket.destroy()
    }
    this.pending.clear()
    const server = this.server
    this.server = null
    this.listening = false
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await unlinkStaleSocket(this.options.socketPath)
    }
  }

  route(clientId: string, request: PodLaneRequest): unknown {
    switch (request.type) {
      case 'podLaneGrant':
        return this.grant(clientId, request.payload.sessionId, request.payload.inputOpen === true)
      case 'podLaneGate':
        this.ownedLane(clientId, request.payload.laneId)?.setInputOpen(
          request.payload.open === true
        )
        return {}
      case 'podLaneSettle':
        this.ownedLane(clientId, request.payload.laneId)?.settle(
          Number(request.payload.fence) || 0,
          request.payload.applied === true
        )
        return {}
      case 'podLaneRevoke':
        this.grants.revoke(request.payload.laneId)
        this.ownedLane(clientId, request.payload.laneId)?.close(
          typeof request.payload.reason === 'string' ? request.payload.reason : 'revoked'
        )
        return {}
    }
  }

  /** Lanes live only as long as main's connection that asked for them. */
  onMainDisconnected(clientId: string): void {
    this.grants.revokeClient(clientId)
    for (const lane of Array.from(this.lanesById.values())) {
      if (lane.clientId === clientId) {
        lane.close('main-disconnected')
      }
    }
  }

  private grant(
    clientId: string,
    sessionId: string,
    inputOpen: boolean
  ): { laneId: string; token: string; socketPath: string } {
    const { ports } = this.options
    if (!this.listening) {
      throw new Error('pod_lane_unavailable')
    }
    if (ports.attachedClientId(sessionId) !== clientId) {
      throw new Error('pod_lane_session_not_attached')
    }
    return {
      ...this.grants.issue(sessionId, clientId, inputOpen),
      socketPath: this.options.socketPath
    }
  }

  private ownedLane(clientId: string, laneId: string): PodLaneConnection | undefined {
    const lane = this.lanesById.get(laneId)
    return lane?.clientId === clientId ? lane : undefined
  }

  private accept(socket: Socket): void {
    const { verifyPeer, ports } = this.options
    const peer = verifyPeer?.(socket)
    if (!peer?.ok) {
      ports.log('pod-lane-peer-refused', { pid: peer?.pid ?? 0, error: peer?.error ?? 'no check' })
      socket.destroy()
      return
    }
    this.pending.add(socket)
    const reader = new PodLaneFrameReader(POD_LANE_MAX_HELLO_BYTES)
    const timer = setTimeout(
      () => socket.destroy(),
      this.options.helloTimeoutMs ?? HELLO_TIMEOUT_MS
    )
    let lane: PodLaneConnection | null = null
    socket.on('data', (chunk: Buffer) => {
      let frames: PodLaneFrame[]
      try {
        frames = reader.push(chunk)
      } catch {
        if (lane) {
          lane.close('bad-frame')
        } else {
          socket.destroy()
        }
        return
      }
      for (const frame of frames) {
        if (lane) {
          if (!this.dispatch(lane, frame)) {
            return
          }
          continue
        }
        clearTimeout(timer)
        this.pending.delete(socket)
        lane = this.hello(socket, frame)
        if (!lane) {
          socket.destroy()
          return
        }
        reader.maxPayloadBytes = POD_LANE_MAX_INPUT_BYTES
      }
    })
    const onGone = (): void => {
      clearTimeout(timer)
      this.pending.delete(socket)
      lane?.close('client-closed')
    }
    socket.on('close', onGone)
    socket.on('error', onGone)
  }

  private hello(socket: Socket, frame: PodLaneFrame): PodLaneConnection | null {
    const { ports } = this.options
    if (frame.type !== PodLaneClientFrame.Hello) {
      return null
    }
    const hello = parseHello(frame.payload)
    const grant = hello ? this.grants.redeem(hello.laneId, hello.token) : null
    if (!grant) {
      ports.log('pod-lane-hello-refused', {})
      return null
    }
    if (ports.attachedClientId(grant.sessionId) !== grant.clientId) {
      return null
    }
    this.laneBySession.get(grant.sessionId)?.close('replaced')
    const lane = new PodLaneConnection({
      ...grant,
      socket,
      ports,
      maxBufferedBytes: this.options.maxBufferedBytes ?? MAX_BUFFERED_OUTPUT_BYTES,
      holdTimeoutMs: this.options.holdTimeoutMs ?? FENCE_HOLD_TIMEOUT_MS,
      onClosed: (closed) => {
        this.lanesById.delete(closed.laneId)
        if (this.laneBySession.get(closed.sessionId) === closed) {
          this.laneBySession.delete(closed.sessionId)
        }
      }
    })
    this.lanesById.set(lane.laneId, lane)
    this.laneBySession.set(lane.sessionId, lane)
    return lane.activate() ? lane : null
  }

  private dispatch(lane: PodLaneConnection, frame: PodLaneFrame): boolean {
    if (frame.type === PodLaneClientFrame.Input) {
      lane.input(frame.payload.toString('utf8'))
      return true
    }
    if (frame.type === PodLaneClientFrame.Fence && frame.payload.length === 8) {
      lane.fence(Number(frame.payload.readBigUInt64BE(0)))
      return true
    }
    lane.close('bad-frame')
    return false
  }
}

function parseHello(payload: Buffer): { laneId: string; token: string } | null {
  try {
    const value: unknown = JSON.parse(payload.toString('utf8'))
    if (
      typeof value === 'object' &&
      value !== null &&
      'v' in value &&
      value.v === POD_LANE_PROTOCOL_VERSION &&
      'laneId' in value &&
      typeof value.laneId === 'string' &&
      'token' in value &&
      typeof value.token === 'string'
    ) {
      return { laneId: value.laneId, token: value.token }
    }
  } catch {
    // Unreadable hello: refused below.
  }
  return null
}

async function isPrivateDirectory(socketPath: string): Promise<boolean> {
  try {
    const dir = await lstat(socketPath.slice(0, socketPath.lastIndexOf('/')))
    return dir.isDirectory() && dir.uid === process.getuid?.() && (dir.mode & 0o077) === 0
  } catch {
    return false
  }
}

async function unlinkStaleSocket(socketPath: string): Promise<void> {
  try {
    if ((await lstat(socketPath)).isSocket()) {
      await unlink(socketPath)
    }
  } catch {
    // Nothing there.
  }
}
