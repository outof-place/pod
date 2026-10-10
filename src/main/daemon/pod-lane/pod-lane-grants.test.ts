import { describe, expect, it } from 'vitest'
import { POD_LANE_GRANT_TTL_MS, PodLaneGrants } from './pod-lane-grants'
import {
  PodLaneFrameReader,
  PodLaneFrameTooLargeError,
  encodePodLaneFrame
} from '../../../shared/pod-terminal-lane-protocol'

describe('PodLaneGrants', () => {
  it('redeems a grant once, bound to its session and main', () => {
    const grants = new PodLaneGrants()
    const { laneId, token } = grants.issue('s1', 'main', true)
    expect(Buffer.from(token, 'base64url')).toHaveLength(32)
    expect(grants.redeem(laneId, token)).toEqual({
      laneId,
      sessionId: 's1',
      clientId: 'main',
      inputOpen: true
    })
    expect(grants.redeem(laneId, token)).toBeNull()
  })

  it('spends the grant on a wrong token, and refuses an expired one', () => {
    let now = 1_000
    const grants = new PodLaneGrants(() => now)
    const wrong = grants.issue('s1', 'main', true)
    expect(grants.redeem(wrong.laneId, 'AAAA')).toBeNull()
    expect(grants.redeem(wrong.laneId, wrong.token)).toBeNull()
    const late = grants.issue('s1', 'main', true)
    now += POD_LANE_GRANT_TTL_MS + 1
    expect(grants.redeem(late.laneId, late.token)).toBeNull()
  })

  it("forgets a main connection's grants with it", () => {
    const grants = new PodLaneGrants()
    const mine = grants.issue('s1', 'main', true)
    grants.issue('s2', 'other', true)
    grants.revokeClient('main')
    expect(grants.redeem(mine.laneId, mine.token)).toBeNull()
    expect(grants.size).toBe(1)
  })
})

describe('PodLaneFrameReader', () => {
  it('reassembles frames split anywhere and refuses one over its limit before buffering it', () => {
    const bytes = Buffer.concat([
      encodePodLaneFrame(2, Buffer.from('abc')),
      encodePodLaneFrame(3, Buffer.alloc(8))
    ])
    const reader = new PodLaneFrameReader(16)
    const frames = [...bytes].flatMap((byte) => reader.push(Buffer.from([byte])))
    expect(frames.map((frame) => [frame.type, frame.payload.length])).toEqual([
      [2, 3],
      [3, 8]
    ])
    expect(() => reader.push(encodePodLaneFrame(2, Buffer.alloc(17)).subarray(0, 5))).toThrow(
      PodLaneFrameTooLargeError
    )
  })
})
