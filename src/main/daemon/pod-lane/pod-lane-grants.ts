// Fork-only (Pod): one-shot grants for the direct terminal lane. Main asks for one per terminal;
// PodNative presents it once, within 10 s, on the lane socket.
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { POD_LANE_TOKEN_BYTES } from '../../../shared/pod-terminal-lane-protocol'

export const POD_LANE_GRANT_TTL_MS = 10_000

export type PodLaneGrant = {
  laneId: string
  sessionId: string
  /** The main control client that asked; the lane lives only as long as its connection. */
  clientId: string
  inputOpen: boolean
}

type StoredGrant = PodLaneGrant & { token: Buffer; expiresAt: number }

export class PodLaneGrants {
  private readonly grants = new Map<string, StoredGrant>()

  constructor(private readonly now: () => number = Date.now) {}

  issue(
    sessionId: string,
    clientId: string,
    inputOpen: boolean
  ): { laneId: string; token: string } {
    this.prune()
    const laneId = randomUUID()
    const token = randomBytes(POD_LANE_TOKEN_BYTES)
    this.grants.set(laneId, {
      laneId,
      sessionId,
      clientId,
      inputOpen,
      token,
      expiresAt: this.now() + POD_LANE_GRANT_TTL_MS
    })
    return { laneId, token: token.toString('base64url') }
  }

  /** Consumes the grant whatever the outcome: a lane id gets one attempt. */
  redeem(laneId: string, token: string): PodLaneGrant | null {
    const grant = this.grants.get(laneId)
    if (!grant) {
      return null
    }
    this.grants.delete(laneId)
    const presented = Buffer.from(token, 'base64url')
    if (
      grant.expiresAt < this.now() ||
      presented.length !== grant.token.length ||
      !timingSafeEqual(presented, grant.token)
    ) {
      return null
    }
    return {
      laneId: grant.laneId,
      sessionId: grant.sessionId,
      clientId: grant.clientId,
      inputOpen: grant.inputOpen
    }
  }

  revokeClient(clientId: string): void {
    for (const [laneId, grant] of this.grants) {
      if (grant.clientId === clientId) {
        this.grants.delete(laneId)
      }
    }
  }

  revoke(laneId: string): void {
    this.grants.delete(laneId)
  }

  get size(): number {
    this.prune()
    return this.grants.size
  }

  private prune(): void {
    const now = this.now()
    for (const [laneId, grant] of this.grants) {
      if (grant.expiresAt < now) {
        this.grants.delete(laneId)
      }
    }
  }
}
