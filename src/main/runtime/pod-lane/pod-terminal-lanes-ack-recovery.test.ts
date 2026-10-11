// Fork-only (Pod): an ack recovery snapshot replaces the viewer's screen, so it must never land
// between a direct lane's attach and detach markers, where the screen follows the lane's bytes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TERMINAL_MULTIPLEX_ACK_STREAM_INITIAL_WINDOW_BYTES,
  TERMINAL_MULTIPLEX_PENDING_MAX_BYTES
} from '../../../shared/terminal-multiplex-flow-control'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamJson,
  type TerminalStreamFrame
} from '../../../shared/terminal-stream-protocol'
import {
  laneMarkers,
  startLaneHarness,
  subscribeLaneHarness,
  type LaneHarness
} from './pod-terminal-lanes-test-harness'
import { handlePodLaneEvent } from './pod-terminal-lanes'

const control = vi.fn()
vi.mock('../../ipc/pty/provider/registry', () => ({
  getProviderForPty: () => ({ podLaneControl: control })
}))

const GRANT = { laneId: 'lane-1', socketPath: '/tmp/x/pod-lane-v44.sock', token: 'tok' }
const CHUNK = 16 * 1024

beforeEach(() => {
  // Why: the lane is macOS-only; these tests model a Mac on every host (Linux CI included).
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  control.mockReset()
  control.mockImplementation((_ptyId: string, type: string) =>
    Promise.resolve(type === 'podLaneGrant' ? GRANT : true)
  )
})

afterEach(() => {
  vi.restoreAllMocks()
})

function harnessWithSeq() {
  let seq = 0
  const harness = startLaneHarness({
    serializeTerminalBuffer: vi.fn(async () => ({
      data: 'snapshot',
      cols: 120,
      rows: 40,
      seq,
      source: 'headless' as const
    }))
  })
  const flood = (bytes: number) => {
    for (let sent = 0; sent < bytes; sent += CHUNK) {
      const data = 'x'.repeat(Math.min(CHUNK, bytes - sent))
      seq += data.length
      harness.push(data, { seq })
    }
  }
  return { harness, flood }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

const snapshotsIn = (frames: TerminalStreamFrame[]) =>
  frames.filter((frame) => frame.opcode === TerminalStreamOpcode.SnapshotStart).length

const revokes = () =>
  control.mock.calls.filter(([, type]) => type === 'podLaneRevoke').map(([, , payload]) => payload)

async function laneReady(harness: LaneHarness) {
  await subscribeLaneHarness(harness)
  await harness.requestLane()
}

describe('direct lane and ack recovery', () => {
  it('refuses the switch while a recovery still owes the viewer its history', async () => {
    const { harness, flood } = harnessWithSeq()
    await laneReady(harness)
    // Past the window and the pending budget: output dropped. A small ack sends the recovery
    // without history (the link is still full), so history stays owed.
    flood(
      TERMINAL_MULTIPLEX_ACK_STREAM_INITIAL_WINDOW_BYTES + 2 * TERMINAL_MULTIPLEX_PENDING_MAX_BYTES
    )
    await settle()
    harness.slot(TerminalStreamOpcode.Ack, { bytes: CHUNK })
    await settle()
    expect(snapshotsIn(harness.frames)).toBe(2)

    handlePodLaneEvent({ id: 'pty-1', kind: 'podLane', laneId: 'lane-1', phase: 'attached' })
    expect(laneMarkers(harness.frames)).toEqual([])
    expect(revokes()).toEqual([{ laneId: 'lane-1', reason: 'stream-not-live' }])
  })

  it('holds a recovery that comes due while the lane is live until its detach marker', async () => {
    const { harness, flood } = harnessWithSeq()
    await laneReady(harness)
    // The window full and the pending queue just under its budget: the attach marker tips it over.
    flood(
      TERMINAL_MULTIPLEX_ACK_STREAM_INITIAL_WINDOW_BYTES + TERMINAL_MULTIPLEX_PENDING_MAX_BYTES - 8
    )
    await settle()
    handlePodLaneEvent({ id: 'pty-1', kind: 'podLane', laneId: 'lane-1', phase: 'attached' })
    const muted = harness.frames.length
    harness.slot(TerminalStreamOpcode.Ack, {
      bytes: TERMINAL_MULTIPLEX_ACK_STREAM_INITIAL_WINDOW_BYTES
    })
    await settle()
    expect(snapshotsIn(harness.frames.slice(muted))).toBe(0)
    expect(revokes()).toEqual([{ laneId: 'lane-1', reason: 'snapshot-requested' }])

    const detachedAt = harness.frames.length
    handlePodLaneEvent({
      id: 'pty-1',
      kind: 'podLane',
      laneId: 'lane-1',
      phase: 'detached',
      reason: 'snapshot-requested'
    })
    await vi.waitFor(() => expect(snapshotsIn(harness.frames.slice(detachedAt))).toBe(1))
    const after = harness.frames.slice(detachedAt)
    const detachedMarker = after.findIndex(
      (frame) =>
        frame.opcode === TerminalStreamOpcode.Metadata &&
        decodeTerminalStreamJson<{ podLane?: { phase: string } }>(frame.payload)?.podLane?.phase ===
          'detached'
    )
    const snapshot = after.findIndex((frame) => frame.opcode === TerminalStreamOpcode.SnapshotStart)
    expect(detachedMarker).toBeGreaterThanOrEqual(0)
    expect(detachedMarker).toBeLessThan(snapshot)
  })
})
