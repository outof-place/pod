import '../rpc/unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../rpc/dispatcher'
import type { OrcaRuntimeService, RuntimeTerminalDataMeta } from '../orca-runtime'
import { TERMINAL_METHODS } from '../rpc/methods/terminal'
import { POD_TERMINAL_LANE_METHODS } from '../rpc/methods/pod-terminal-lane'
import { createSubscriptionRegistryDouble } from '../rpc/subscription-registry-test-double'
import type { RuntimeTerminalWait } from '../../../shared/runtime-types'
import type { RuntimeTerminalDriverState } from '../../../shared/runtime-session-contracts'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  type TerminalStreamFrame
} from '../../../shared/terminal-stream-protocol'
import {
  makeRequest,
  sendDesktopMultiplexSubscribe,
  stubRuntime
} from '../rpc/terminal-multiplex-test-harness'
import { handlePodLaneEvent } from './pod-terminal-lanes'
import { recordPodLaneInput } from './pod-lane-input-records'

const control = vi.fn()
vi.mock('../../ipc/pty/provider/registry', () => ({
  getProviderForPty: () => ({ podLaneControl: control })
}))

const CONNECTION = 'local-stream-test'
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

function start(overrides: Partial<OrcaRuntimeService> = {}) {
  const frames: TerminalStreamFrame[] = []
  const messages: string[] = []
  const handlers = new Map<number, (frame: TerminalStreamFrame) => void>()
  const dataListeners: ((data: string, meta?: RuntimeTerminalDataMeta) => void)[] = []
  const driverListeners: (() => void)[] = []
  let driver: RuntimeTerminalDriverState = { kind: 'idle' }
  const registry = createSubscriptionRegistryDouble()
  const runtime = stubRuntime({
    readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
    serializeTerminalBuffer: vi.fn().mockResolvedValue({ data: 'snapshot', cols: 120, rows: 40 }),
    getTerminalSize: vi.fn().mockReturnValue({ cols: 120, rows: 40 }),
    getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
    getLayout: vi.fn().mockReturnValue({ seq: 1 }),
    subscribeToTerminalData: vi.fn((_ptyId, listener) => {
      dataListeners.push(listener)
      return vi.fn()
    }),
    subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
    subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
    subscribeToDriverChanges: vi.fn((_ptyId, listener) => {
      driverListeners.push(() => listener(driver))
      return vi.fn()
    }),
    getTerminalFitOverride: vi.fn().mockReturnValue(null),
    getDriver: vi.fn(() => driver),
    registerSubscriptionCleanup: vi.fn(registry.registerSubscriptionCleanup),
    cleanupSubscriptionsForConnection: vi.fn(registry.cleanupSubscriptionsForConnection),
    waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
    ...overrides
  })
  const dispatcher = new RpcDispatcher({
    runtime,
    methods: [...TERMINAL_METHODS, ...POD_TERMINAL_LANE_METHODS]
  })
  void dispatcher.dispatchStreaming(
    makeRequest('terminal.multiplex', {}),
    (msg) => messages.push(msg),
    {
      connectionId: CONNECTION,
      sendBinary: (bytes) => {
        const frame = decodeTerminalStreamFrame(bytes)
        if (frame) {
          frames.push(frame)
        }
      },
      registerBinaryStreamHandler: (streamId, handler) => {
        handlers.set(streamId, handler)
        return () => handlers.delete(streamId)
      }
    }
  )
  const requestLane = async (streamId = 7) => {
    const response = await dispatcher.dispatch(
      makeRequest('pod.terminal.directLane', { streamId }),
      {
        connectionId: CONNECTION
      }
    )
    return response.ok ? { result: response.result } : { error: response.error }
  }
  const slot = (opcode: TerminalStreamOpcode, payload: unknown, seq = 0) =>
    handlers.get(7)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode,
          streamId: 7,
          seq,
          payload: encodeTerminalStreamJson(payload)
        })
      )!
    )
  const push = (data: string) => dataListeners.forEach((listener) => listener(data, { seq: 1 }))
  const setDriver = (next: typeof driver) => {
    driver = next
    driverListeners.forEach((listener) => listener())
  }
  return { frames, messages, handlers, requestLane, slot, push, setDriver }
}

async function subscribed(harness: ReturnType<typeof start>) {
  await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
  sendDesktopMultiplexSubscribe(harness.handlers)
  await vi.waitFor(() =>
    expect(harness.frames.some((frame) => frame.opcode === TerminalStreamOpcode.SnapshotEnd)).toBe(
      true
    )
  )
}

const laneMarkers = (frames: TerminalStreamFrame[]) =>
  frames
    .filter((frame) => frame.opcode === TerminalStreamOpcode.Metadata)
    .map(
      (frame) =>
        decodeTerminalStreamJson<{ podLane?: { phase: string } }>(frame.payload)?.podLane?.phase
    )
    .filter(Boolean)

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
