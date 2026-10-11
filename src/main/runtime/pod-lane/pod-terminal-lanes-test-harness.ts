// Fork-only (Pod): a desktop multiplex stream on a local connection, with pod.terminal.directLane,
// for the lane tests. The test file mocks the provider registry (the daemon's lane control).
import '../rpc/unused-default-rpc-methods.test-fixture'
import { expect, vi } from 'vitest'
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

export const LANE_TEST_CONNECTION = 'local-stream-test'

export function startLaneHarness(overrides: Partial<OrcaRuntimeService> = {}) {
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
      connectionId: LANE_TEST_CONNECTION,
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
        connectionId: LANE_TEST_CONNECTION
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
  const push = (data: string, meta: RuntimeTerminalDataMeta = { seq: 1 }) =>
    dataListeners.forEach((listener) => listener(data, meta))
  const setDriver = (next: typeof driver) => {
    driver = next
    driverListeners.forEach((listener) => listener())
  }
  return { frames, messages, handlers, requestLane, slot, push, setDriver }
}

export type LaneHarness = ReturnType<typeof startLaneHarness>

export async function subscribeLaneHarness(harness: LaneHarness) {
  await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
  sendDesktopMultiplexSubscribe(harness.handlers)
  await vi.waitFor(() =>
    expect(harness.frames.some((frame) => frame.opcode === TerminalStreamOpcode.SnapshotEnd)).toBe(
      true
    )
  )
}

export const laneMarkers = (frames: TerminalStreamFrame[]) =>
  frames
    .filter((frame) => frame.opcode === TerminalStreamOpcode.Metadata)
    .map(
      (frame) =>
        decodeTerminalStreamJson<{ podLane?: { phase: string } }>(frame.payload)?.podLane?.phase
    )
    .filter(Boolean)
