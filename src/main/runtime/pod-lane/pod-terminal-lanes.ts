// Fork-only (Pod): main's side of the direct terminal lane (design: PodNative README, "Direct
// terminal lane"). Main grants a lane for one multiplex stream, switches that stream's output off at
// the daemon's marker and back on (with a snapshot) when the lane ends, gates the lane's input like
// its own (a phone driving, viewport claims), and records what the lane wrote.
import {
  TerminalStreamOpcode,
  encodeTerminalStreamJson
} from '../../../shared/terminal-stream-protocol'
import { isRuntimeLocalStreamConnectionId } from '../../../shared/runtime-local-stream-protocol'
import { getProviderForPty } from '../../ipc/pty/provider/registry'
import type { PtyBackgroundStreamEvent } from '../../providers/pty-provider-events'
import type { PodLaneRequest } from '../../daemon/pod-lane/pod-lane-requests'
import { isTerminalInputLockedForClient } from '../rpc/methods/terminal/terminal-input-delivery'
import {
  isMultiplexStreamAttached,
  type TerminalMultiplexConnection
} from '../rpc/methods/terminal/terminal-multiplex-connection'
import type { TerminalMultiplexStream } from '../rpc/methods/terminal/terminal-stream-types'

export type PodLaneGrant = { laneId: string; socketPath: string; token: string }

export type PodLaneEvent = Extract<PtyBackgroundStreamEvent, { kind: 'podLane' | 'podLaneInput' }>

type PodLaneControl = (
  ptyId: string,
  type: PodLaneRequest['type'],
  payload: PodLaneRequest['payload']
) => Promise<unknown>

type Lane = {
  laneId: string
  ptyId: string
  state: TerminalMultiplexConnection
  stream: TerminalMultiplexStream
  control: PodLaneControl
  muted: boolean
  releaseDriver: () => void
}

const connections = new Map<string, TerminalMultiplexConnection>()
const lanes = new Map<string, Lane>()
const laneByStream = new WeakMap<TerminalMultiplexStream, Lane>()

export function isPodTerminalLaneDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.POD_TERMINAL_DIRECT_LANE === '0' || process.platform !== 'darwin'
}

/** The multiplex connections a lane grant can name; local stream connections only. */
export function registerPodLaneConnection(state: TerminalMultiplexConnection): () => void {
  if (!isRuntimeLocalStreamConnectionId(state.connectionId)) {
    return () => {}
  }
  connections.set(state.connectionId, state)
  return () => {
    if (connections.get(state.connectionId) === state) {
      connections.delete(state.connectionId)
    }
  }
}

export function isPodLaneMuted(stream: TerminalMultiplexStream): boolean {
  return laneByStream.get(stream)?.muted === true
}

export async function grantPodTerminalLane(
  connectionId: string | undefined,
  streamId: number
): Promise<PodLaneGrant> {
  if (isPodTerminalLaneDisabled()) {
    throw new Error('pod_lane_disabled')
  }
  const state = connectionId ? connections.get(connectionId) : undefined
  const stream = state?.streams.get(streamId)
  if (!state || !stream || !isMultiplexStreamAttached(state, stream)) {
    throw new Error('pod_lane_no_stream')
  }
  if (stream.isMobile || stream.buffering || !stream.client?.id) {
    throw new Error('pod_lane_stream_not_ready')
  }
  const provider = getProviderForPty(stream.ptyId)
  if (!provider.podLaneControl) {
    throw new Error('pod_lane_unavailable')
  }
  const control: PodLaneControl = (ptyId, type, payload) =>
    provider.podLaneControl?.(ptyId, type, payload) ??
    Promise.reject(new Error('pod_lane_unavailable'))
  const previous = laneByStream.get(stream)
  if (previous) {
    endLane(previous, 'replaced')
  }
  const inputOpen = !isTerminalInputLockedForClient(state.runtime, stream.ptyId, stream.client)
  const granted = parseGrant(
    await control(stream.ptyId, 'podLaneGrant', { sessionId: stream.ptyId, inputOpen })
  )
  if (!isMultiplexStreamAttached(state, stream)) {
    void control(stream.ptyId, 'podLaneRevoke', {
      laneId: granted.laneId,
      reason: 'stream-detached'
    })
    throw new Error('pod_lane_no_stream')
  }
  const lane: Lane = {
    laneId: granted.laneId,
    ptyId: stream.ptyId,
    state,
    stream,
    control,
    muted: false,
    releaseDriver: () => {}
  }
  lane.releaseDriver = state.runtime.subscribeToDriverChanges(stream.ptyId, () => {
    const open = !isTerminalInputLockedForClient(state.runtime, lane.ptyId, stream.client)
    void control(lane.ptyId, 'podLaneGate', { laneId: lane.laneId, open }).catch(() => {})
  })
  // Why: a detached stream ends its lane however the detach came about.
  const unsubscribeData = stream.unsubscribeData
  stream.unsubscribeData = () => {
    endLane(lane, 'stream-detached')
    unsubscribeData()
  }
  lanes.set(lane.laneId, lane)
  laneByStream.set(stream, lane)
  return granted
}

/** The daemon's markers, in byte order with the PTY's data. */
export function handlePodLaneEvent(event: PodLaneEvent): void {
  if (event.kind !== 'podLane') {
    return
  }
  const lane = lanes.get(event.laneId)
  if (!lane || lane.ptyId !== event.id) {
    return
  }
  const { state, stream } = lane
  if (event.phase === 'attached') {
    if (!isMultiplexStreamAttached(state, stream) || stream.buffering) {
      endLane(lane, 'stream-not-live')
      return
    }
    stream.outputBatcher.flush()
    state.queueOrSendOutput(stream, laneMarker(lane.laneId, 'attached'))
    lane.muted = true
    return
  }
  forget(lane)
  if (!lane.muted || !isMultiplexStreamAttached(state, stream)) {
    return
  }
  lane.muted = false
  // Why: output queued before the marker never reached the viewer; the snapshot covers it.
  stream.ackPendingOutput = []
  stream.ackPendingOutputBytes = 0
  stream.ackPendingOutputOverflowed = false
  state.sendFrame(
    stream.streamId,
    TerminalStreamOpcode.Metadata,
    laneMarker(lane.laneId, 'detached').bytes
  )
  if (event.reason !== 'exited') {
    void state.sendRequestedSnapshot(stream, {})
  }
}

/** A Resize frame stamped `fence`: once its claim settles in main (resize sent), the held lane input follows. */
export function settlePodLaneFence(stream: TerminalMultiplexStream, fence: number): void {
  const lane = laneByStream.get(stream)
  if (!lane || fence <= 0) {
    return
  }
  queueMicrotask(() => {
    void stream.desktopClaimTail
      .then((applied) =>
        lane.control(lane.ptyId, 'podLaneSettle', { laneId: lane.laneId, fence, applied })
      )
      .catch(() => {})
  })
}

function endLane(lane: Lane, reason: string): void {
  if (forget(lane)) {
    void lane.control(lane.ptyId, 'podLaneRevoke', { laneId: lane.laneId, reason }).catch(() => {})
  }
}

function forget(lane: Lane): boolean {
  if (lanes.get(lane.laneId) !== lane) {
    return false
  }
  lanes.delete(lane.laneId)
  if (laneByStream.get(lane.stream) === lane) {
    laneByStream.delete(lane.stream)
  }
  lane.releaseDriver()
  return true
}

function laneMarker(laneId: string, phase: 'attached' | 'detached') {
  return {
    opcode: TerminalStreamOpcode.Metadata,
    bytes: encodeTerminalStreamJson({ podLane: { laneId, phase } }),
    displayLength: 0
  }
}

function parseGrant(value: unknown): PodLaneGrant {
  if (
    typeof value === 'object' &&
    value !== null &&
    'laneId' in value &&
    typeof value.laneId === 'string' &&
    'socketPath' in value &&
    typeof value.socketPath === 'string' &&
    'token' in value &&
    typeof value.token === 'string'
  ) {
    return { laneId: value.laneId, socketPath: value.socketPath, token: value.token }
  }
  throw new Error('pod_lane_unavailable')
}
