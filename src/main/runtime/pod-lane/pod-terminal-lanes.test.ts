import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalStreamOpcode } from '../../../shared/terminal-stream-protocol'
import {
  laneMarkers,
  startLaneHarness as start,
  subscribeLaneHarness as subscribed
} from './pod-terminal-lanes-test-harness'
import { handlePodLaneEvent } from './pod-terminal-lanes'
import { recordPodLaneInput } from './pod-lane-input-records'

const control = vi.fn()
vi.mock('../../ipc/pty/provider/registry', () => ({
  getProviderForPty: () => ({ podLaneControl: control })
}))

const GRANT = { laneId: 'lane-1', socketPath: '/tmp/x/pod-lane-v44.sock', token: 'tok' }

beforeEach(() => {
  // Why: the lane is macOS-only; these tests model a Mac on every host (Linux CI included).
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  control.mockReset()
  control.mockImplementation((_ptyId: string, type: string) =>
    Promise.resolve(type === 'podLaneGrant' ? GRANT : true)
  )
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('pod.terminal.directLane', () => {
  it('grants a lane for a live desktop stream on this local connection, and not with the kill switch', async () => {
    const harness = start()
    await subscribed(harness)
    expect((await harness.requestLane()).result).toEqual(GRANT)
    expect(control).toHaveBeenCalledWith('pty-1', 'podLaneGrant', {
      sessionId: 'pty-1',
      inputOpen: true
    })
    expect((await harness.requestLane(99)).error?.message).toContain('pod_lane_no_stream')
    vi.stubEnv('POD_TERMINAL_DIRECT_LANE', '0')
    expect((await harness.requestLane()).error?.message).toContain('pod_lane_disabled')
  })

  it('grants no lane off macOS', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const harness = start()
    await subscribed(harness)
    expect((await harness.requestLane()).error?.message).toContain('pod_lane_disabled')
    expect(control).not.toHaveBeenCalledWith('pty-1', 'podLaneGrant', expect.anything())
  })

  it("switches the stream's output off at the daemon's marker and back on with a snapshot", async () => {
    const harness = start()
    await subscribed(harness)
    await harness.requestLane()
    harness.push('before')
    handlePodLaneEvent({ id: 'pty-1', kind: 'podLane', laneId: 'lane-1', phase: 'attached' })
    harness.push('after')
    await new Promise((resolve) => setTimeout(resolve, 20))
    const outputs = harness.frames.filter((frame) => frame.opcode === TerminalStreamOpcode.Output)
    expect(outputs.map((frame) => Buffer.from(frame.payload).toString())).toEqual(['before'])
    expect(laneMarkers(harness.frames)).toEqual(['attached'])
    const markerAt = harness.frames.findIndex(
      (frame) => frame.opcode === TerminalStreamOpcode.Metadata
    )
    const [firstOutput] = outputs
    expect(firstOutput && harness.frames.indexOf(firstOutput)).toBeLessThan(markerAt)

    const before = harness.frames.length
    handlePodLaneEvent({
      id: 'pty-1',
      kind: 'podLane',
      laneId: 'lane-1',
      phase: 'detached',
      reason: 'client-closed'
    })
    await vi.waitFor(() =>
      expect(
        harness.frames
          .slice(before)
          .some((frame) => frame.opcode === TerminalStreamOpcode.SnapshotEnd)
      ).toBe(true)
    )
    expect(laneMarkers(harness.frames)).toEqual(['attached', 'detached'])
    harness.push('again')
    await vi.waitFor(() =>
      expect(
        harness.frames.some(
          (frame) =>
            frame.opcode === TerminalStreamOpcode.Output &&
            Buffer.from(frame.payload).toString() === 'again'
        )
      ).toBe(true)
    )
  })

  it('closes the input gate while a phone drives, settles viewport fences, and revokes on detach', async () => {
    const harness = start()
    await subscribed(harness)
    await harness.requestLane()
    harness.setDriver({ kind: 'mobile', clientId: 'phone' })
    expect(control).toHaveBeenCalledWith('pty-1', 'podLaneGate', { laneId: 'lane-1', open: false })

    harness.slot(TerminalStreamOpcode.Resize, { cols: 100, rows: 30 }, 3)
    await vi.waitFor(() =>
      expect(control).toHaveBeenCalledWith('pty-1', 'podLaneSettle', {
        laneId: 'lane-1',
        fence: 3,
        applied: true
      })
    )
    harness.slot(TerminalStreamOpcode.Unsubscribe, {})
    expect(control).toHaveBeenCalledWith('pty-1', 'podLaneRevoke', {
      laneId: 'lane-1',
      reason: 'stream-detached'
    })
  })
})

describe('recordPodLaneInput', () => {
  it("records the lane's input with the daemon's write time", () => {
    const recordInput = vi.fn()
    recordPodLaneInput(
      { terminalRunFacts: { recordInput }, observeClaudeTerminalEvidence: vi.fn() },
      'pty-1',
      'ls\r',
      1234
    )
    expect(recordInput).toHaveBeenCalledWith('pty-1', 'driving', 'ls\r', 1234)
  })
})
