// Fork-only (Pod): one live direct lane. Input goes through the same session write main's writes
// use, after the checks main would have made (see the README's consumer table); output is every PTY
// chunk after main's switch marker, sent before the daemon's emulator parses it.
import type { Socket } from 'node:net'
import { setImmediate as waitForImmediate } from 'node:timers/promises'
import { iterateTerminalInputChunks } from '../../../shared/terminal-input'
import {
  PodLaneServerFrame,
  encodePodLaneFrame,
  encodePodLaneJson
} from '../../../shared/pod-terminal-lane-protocol'
import type { DaemonEvent } from '../types'
import { podTrace } from '../../../shared/pod-terminal-trace'

/** Main's own record of input; past this the bookkeeping only needs to know it was typed. */
const LANE_INPUT_EVENT_MAX_CHARS = 4096

export type PodLaneTap = {
  onData: (data: string) => void
  onExit: (code: number) => void
}

export type PodLanePorts = {
  attachedClientId: (sessionId: string) => string | undefined
  /** Null when the session is gone. */
  attachTap: (sessionId: string, tap: PodLaneTap) => symbol | null
  detachTap: (sessionId: string, token: symbol) => void
  write: (sessionId: string, data: string) => void
  recordInput: (sessionId: string) => void
  enqueueEvent: (clientId: string, sessionId: string, event: DaemonEvent) => void
  flush: (clientId: string) => void
  log: (event: string, details?: Record<string, unknown>) => void
}

export type PodLaneConnectionOptions = {
  laneId: string
  sessionId: string
  clientId: string
  inputOpen: boolean
  socket: Socket
  ports: PodLanePorts
  maxBufferedBytes: number
  holdTimeoutMs: number
  onClosed: (lane: PodLaneConnection) => void
}

export class PodLaneConnection {
  readonly laneId: string
  readonly sessionId: string
  readonly clientId: string
  private inputOpen: boolean
  private pendingFence = 0
  private settledFence = 0
  private held: string[] = []
  private holdTimer: ReturnType<typeof setTimeout> | null = null
  private writeQueue: string[] = []
  private pumping = false
  private closed = false
  private tapToken: symbol | null = null

  constructor(private readonly options: PodLaneConnectionOptions) {
    this.laneId = options.laneId
    this.sessionId = options.sessionId
    this.clientId = options.clientId
    this.inputOpen = options.inputOpen
  }

  get isClosed(): boolean {
    return this.closed
  }

  /** Marker into main's stream at this byte, then the tap: every later chunk reaches both. */
  activate(): boolean {
    const { ports } = this.options
    ports.enqueueEvent(this.clientId, this.sessionId, {
      type: 'event',
      event: 'podLane',
      sessionId: this.sessionId,
      payload: { laneId: this.laneId, phase: 'attached' }
    })
    this.tapToken = ports.attachTap(this.sessionId, {
      onData: (data) => this.sendOutput(data),
      onExit: (code) => {
        this.send(encodePodLaneJson(PodLaneServerFrame.Exit, { code }))
        this.close('exited')
      }
    })
    ports.flush(this.clientId)
    if (!this.tapToken) {
      this.close('session-gone')
      return false
    }
    this.send(encodePodLaneJson(PodLaneServerFrame.Ready, { v: 1, sessionId: this.sessionId }))
    return true
  }

  input(data: string): void {
    if (this.closed || data.length === 0) {
      return
    }
    if (this.pendingFence > this.settledFence) {
      this.held.push(data)
      this.holdTimer ??= setTimeout(
        () => this.releaseHeldAfterTimeout(),
        this.options.holdTimeoutMs
      )
      return
    }
    this.admit(data)
  }

  fence(k: number): void {
    if (k > this.pendingFence) {
      this.pendingFence = k
    }
  }

  /** Main applied (or refused) viewport claim `fence`; input held behind it follows or is dropped. */
  settle(fence: number, applied: boolean): void {
    if (fence > this.settledFence) {
      this.settledFence = fence
    }
    if (!applied) {
      this.dropHeld('claim')
    }
    if (this.pendingFence <= this.settledFence) {
      this.releaseHeld()
    }
  }

  setInputOpen(open: boolean): void {
    this.inputOpen = open
  }

  close(reason: string): void {
    if (this.closed) {
      return
    }
    this.closed = true
    if (this.holdTimer) {
      clearTimeout(this.holdTimer)
      this.holdTimer = null
    }
    this.held = []
    this.writeQueue = []
    const { ports, socket } = this.options
    if (this.tapToken) {
      ports.detachTap(this.sessionId, this.tapToken)
      this.tapToken = null
    }
    ports.enqueueEvent(this.clientId, this.sessionId, {
      type: 'event',
      event: 'podLane',
      sessionId: this.sessionId,
      payload: { laneId: this.laneId, phase: 'detached', reason }
    })
    ports.flush(this.clientId)
    ports.log('pod-lane-closed', { sessionId: this.sessionId, reason })
    if (!socket.destroyed) {
      socket.end(encodePodLaneJson(PodLaneServerFrame.Closed, { reason }))
      socket.destroySoon()
    }
    this.options.onClosed(this)
  }

  private sendOutput(data: string): void {
    if (this.closed) {
      return
    }
    this.send(encodePodLaneFrame(PodLaneServerFrame.Output, Buffer.from(data, 'utf8')))
    podTrace('d.lout', data.length)
    // Why: a client that stopped reading must not grow the daemon; the multiplex stream takes over.
    if (this.options.socket.writableLength > this.options.maxBufferedBytes) {
      this.close('backpressure')
    }
  }

  private send(frame: Buffer): void {
    const { socket } = this.options
    if (!socket.destroyed) {
      socket.write(frame)
    }
  }

  // Main drops desktop input while a phone drives; the lane does the same.
  private admit(data: string): void {
    if (!this.inputOpen) {
      this.send(
        encodePodLaneJson(PodLaneServerFrame.Dropped, { bytes: data.length, reason: 'locked' })
      )
      return
    }
    if (!this.pumping && this.writeQueue.length === 0 && !this.needsChunks(data)) {
      this.write(data, true)
      return
    }
    this.writeQueue.push(data)
    void this.pump()
  }

  private needsChunks(data: string): boolean {
    const first = iterateTerminalInputChunks(data).next()
    return first.done === true || first.value.length !== data.length
  }

  // Main's terminal writes go in 16 KiB chunks with a yield between; a large paste does the same here.
  private async pump(): Promise<void> {
    if (this.pumping) {
      return
    }
    this.pumping = true
    try {
      for (
        let data = this.writeQueue.shift();
        data !== undefined && !this.closed;
        data = this.writeQueue.shift()
      ) {
        let first = true
        for (const chunk of iterateTerminalInputChunks(data)) {
          if (this.closed || !this.write(chunk, first, data)) {
            return
          }
          first = false
          await waitForImmediate()
        }
      }
    } finally {
      this.pumping = false
    }
  }

  /** Main's bookkeeping first, on its ordered stream and ahead of any exit; then the PTY. */
  private write(chunk: string, firstOfInput: boolean, whole: string = chunk): boolean {
    const { ports } = this.options
    if (firstOfInput) {
      ports.enqueueEvent(this.clientId, this.sessionId, {
        type: 'event',
        event: 'podLaneInput',
        sessionId: this.sessionId,
        payload: {
          data:
            whole.length > LANE_INPUT_EVENT_MAX_CHARS
              ? whole.slice(0, LANE_INPUT_EVENT_MAX_CHARS)
              : whole,
          ...(whole.length > LANE_INPUT_EVENT_MAX_CHARS ? { truncated: true as const } : {}),
          at: Date.now()
        }
      })
    }
    try {
      podTrace('d.lin', chunk.length)
      ports.recordInput(this.sessionId)
      ports.write(this.sessionId, chunk)
      return true
    } catch {
      this.close('session-gone')
      return false
    }
  }

  private releaseHeld(): void {
    if (this.holdTimer) {
      clearTimeout(this.holdTimer)
      this.holdTimer = null
    }
    const held = this.held
    this.held = []
    for (const data of held) {
      this.admit(data)
    }
  }

  private releaseHeldAfterTimeout(): void {
    this.holdTimer = null
    this.options.ports.log('pod-lane-fence-timeout', {
      sessionId: this.sessionId,
      pendingFence: this.pendingFence,
      settledFence: this.settledFence
    })
    this.settledFence = this.pendingFence
    this.releaseHeld()
  }

  private dropHeld(reason: string): void {
    const bytes = this.held.reduce((sum, data) => sum + data.length, 0)
    this.held = []
    if (bytes > 0) {
      this.send(encodePodLaneJson(PodLaneServerFrame.Dropped, { bytes, reason }))
    }
  }
}
