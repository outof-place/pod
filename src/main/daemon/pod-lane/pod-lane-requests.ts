// Fork-only (Pod): main's control requests for the direct terminal lane (pod-lane-server.ts).

export type PodLaneGrantRequest = {
  id: string
  type: 'podLaneGrant'
  payload: { sessionId: string; inputOpen: boolean }
}

/** Notify: main's input gate (closed while a phone drives the terminal). */
export type PodLaneGateRequest = {
  id: string
  type: 'podLaneGate'
  payload: { laneId: string; open: boolean }
}

/** Notify: viewport claim `fence` settled in main, after its resize went out. */
export type PodLaneSettleRequest = {
  id: string
  type: 'podLaneSettle'
  payload: { laneId: string; fence: number; applied: boolean }
}

export type PodLaneRevokeRequest = {
  id: string
  type: 'podLaneRevoke'
  payload: { laneId: string; reason: string }
}

export type PodLaneRequest =
  | PodLaneGrantRequest
  | PodLaneGateRequest
  | PodLaneSettleRequest
  | PodLaneRevokeRequest

const POD_LANE_REQUEST_TYPES: ReadonlySet<string> = new Set([
  'podLaneGrant',
  'podLaneGate',
  'podLaneSettle',
  'podLaneRevoke'
])

export function isPodLaneRequest(request: { type: string }): request is PodLaneRequest {
  return POD_LANE_REQUEST_TYPES.has(request.type)
}
