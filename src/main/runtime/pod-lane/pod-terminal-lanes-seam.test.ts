// The stream/lane seam end to end through main: a simulated daemon (the lane's tap and markers in
// byte order with the data, main's copy late), and a viewer that follows PodNative's
// SurfaceStreamBridge (held lane output until the switch marker, gap snapshots, lane retries). Every
// step checks the viewer's screen: each line once, in order.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamJson,
  decodeTerminalStreamText,
  type TerminalStreamFrame
} from '../../../shared/terminal-stream-protocol'
import { sendDesktopMultiplexSubscribe } from '../rpc/terminal-multiplex-test-harness'
import { startLaneHarness, type LaneHarness } from './pod-terminal-lanes-test-harness'
import { handlePodLaneEvent } from './pod-terminal-lanes'

const control = vi.fn()
vi.mock('../../ipc/pty/provider/registry', () => ({
  getProviderForPty: () => ({ podLaneControl: control })
}))

const LINE = 9
const lineText = (line: number) => `L${String(line).padStart(6, '0')}\r\n`
const linesIn = (text: string) =>
  [...text.matchAll(/L(\d{6})\r\n/g)].map((match) => Number(match[1]))

type LaneFrame =
  | { kind: 'output'; laneId: string; line: number }
  | { kind: 'closed'; laneId: string }
type MainEvent =
  | { kind: 'data'; line: number }
  | { kind: 'marker'; laneId: string; phase: 'attached' | 'detached'; reason?: string }
type DaemonOp = { kind: 'hello' | 'revoke' | 'client-closed'; laneId: string; reason?: string }

/** Pod's terminal daemon, as far as the seam goes: one tap, markers queued where the bytes are. */
class Daemon {
  emitted = 0
  tap: string | null = null
  revoked = new Set<string>()
  readonly mainInbox: MainEvent[] = []
  readonly laneFrames: LaneFrame[] = []
  readonly ops: DaemonOp[] = []

  emit(): void {
    const line = this.emitted++
    if (this.tap) {
      this.laneFrames.push({ kind: 'output', laneId: this.tap, line })
    }
    this.mainInbox.push({ kind: 'data', line })
  }

  runOp(op: DaemonOp): void {
    if (op.kind === 'hello') {
      if (this.revoked.has(op.laneId)) {
        this.laneFrames.push({ kind: 'closed', laneId: op.laneId })
        return
      }
      if (this.tap) {
        this.close(this.tap, 'replaced')
      }
      this.mainInbox.push({ kind: 'marker', laneId: op.laneId, phase: 'attached' })
      this.tap = op.laneId
      return
    }
    this.revoked.add(op.laneId)
    this.close(op.laneId, op.reason ?? op.kind)
  }

  close(laneId: string, reason: string): void {
    if (this.tap !== laneId) {
      return
    }
    this.tap = null
    this.mainInbox.push({ kind: 'marker', laneId, phase: 'detached', reason })
    this.laneFrames.push({ kind: 'closed', laneId })
  }
}

/** PodNative's SurfaceStreamBridge + TerminalMultiplexStream, minus Ghostty. */
class Viewer {
  screen: number[] = []
  framesSeen: number
  switches = 0
  violations: string[] = []
  private expected: number | null = null
  private snapshot: { seq?: number; text: string } | null = null
  private seeded = false
  laneId: string | null = null
  requesting = false
  private connected = false
  private switchedId: string | null = null
  private held: number[] = []

  constructor(
    private readonly harness: LaneHarness,
    private readonly daemon: Daemon
  ) {
    this.framesSeen = harness.frames.length
  }

  get wantsLane(): boolean {
    return this.seeded && this.laneId === null && !this.requesting
  }

  private get isLive(): boolean {
    return this.switchedId !== null && this.switchedId === this.laneId && this.connected
  }

  stepStream(): boolean {
    const frame = this.harness.frames[this.framesSeen]
    if (!frame) {
      return false
    }
    this.framesSeen += 1
    this.handle(frame)
    return true
  }

  private handle(frame: TerminalStreamFrame): void {
    if (frame.opcode === TerminalStreamOpcode.SnapshotStart) {
      const start = decodeTerminalStreamJson<{ seq?: number }>(frame.payload)
      this.snapshot = { seq: start?.seq, text: '' }
    } else if (frame.opcode === TerminalStreamOpcode.SnapshotChunk && this.snapshot) {
      this.snapshot.text += decodeTerminalStreamText(frame.payload)
    } else if (frame.opcode === TerminalStreamOpcode.SnapshotEnd && this.snapshot) {
      this.expected = this.snapshot.seq ?? this.expected
      this.screen = linesIn(this.snapshot.text)
      this.snapshot = null
      this.seeded = true
      this.check('seed')
    } else if (frame.opcode === TerminalStreamOpcode.Output) {
      this.live(decodeTerminalStreamText(frame.payload), frame.seq, undefined)
    } else if (frame.opcode === TerminalStreamOpcode.OutputSpan) {
      const span = decodeTerminalStreamJson<{ data: string; rawLength?: number }>(frame.payload)
      this.live(span?.data ?? '', frame.seq, span?.rawLength)
    } else if (frame.opcode === TerminalStreamOpcode.Metadata) {
      const marker = decodeTerminalStreamJson<{ podLane?: { laneId: string; phase: string } }>(
        frame.payload
      )
      if (marker?.podLane) {
        this.laneSwitch(marker.podLane.laneId, marker.podLane.phase === 'attached')
      }
    }
  }

  private live(text: string, seq: number, rawLength: number | undefined): void {
    const raw = rawLength ?? text.length
    if (seq > 0 && this.expected !== null && seq > raw && seq - raw > this.expected) {
      this.requestSnapshot()
    }
    if (seq > 0) {
      this.expected = seq
    }
    this.harness.slot(TerminalStreamOpcode.Ack, { bytes: Buffer.byteLength(text) })
    if (this.isLive) {
      return
    }
    this.screen.push(...linesIn(text))
    this.check('stream output')
  }

  requestSnapshot(): void {
    this.harness.slot(TerminalStreamOpcode.SnapshotRequest, { scrollbackRows: 1000 })
  }

  private laneSwitch(laneId: string, attached: boolean): void {
    if (!attached) {
      if (this.switchedId === laneId) {
        this.switchedId = null
      }
      return
    }
    if (this.laneId !== laneId || this.switchedId === laneId) {
      return
    }
    this.switchedId = laneId
    this.switches += 1
    this.screen.push(...this.held)
    this.held = []
    this.check('switch')
  }

  stepLane(frame: LaneFrame): void {
    if (frame.laneId !== this.laneId) {
      return
    }
    if (frame.kind === 'closed') {
      this.laneFailed()
      return
    }
    if (this.switchedId === frame.laneId) {
      this.screen.push(frame.line)
      this.check('lane output')
    } else {
      this.held.push(frame.line)
    }
  }

  async requestLane(): Promise<void> {
    this.requesting = true
    const response = await this.harness.requestLane()
    this.requesting = false
    const grant = response.result
    if (
      typeof grant !== 'object' ||
      grant === null ||
      !('laneId' in grant) ||
      typeof grant.laneId !== 'string'
    ) {
      return
    }
    this.laneId = grant.laneId
    this.connected = true
    this.daemon.ops.push({ kind: 'hello', laneId: grant.laneId })
  }

  /** The lane socket went away, or this side closed it. */
  laneFailed(): void {
    this.laneId = null
    this.connected = false
    this.held = []
  }

  closeLane(): void {
    if (this.laneId) {
      this.daemon.ops.push({ kind: 'client-closed', laneId: this.laneId })
      this.laneFailed()
    }
  }

  private check(where: string): void {
    const bad = this.screen.findIndex((line, index) => line !== index)
    if (bad !== -1 && this.violations.length < 5) {
      this.violations.push(
        `${where}: screen[${bad}] = ${this.screen[bad]} (${this.screen.slice(Math.max(0, bad - 2), bad + 3).join(',')})`
      )
    }
  }
}

function seededRandom(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    return state / 0x7fffffff
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

async function runSeam(seed: number, targetSwitches: number) {
  const random = seededRandom(seed)
  const daemon = new Daemon()
  const mainLines: number[] = []
  let grants = 0
  control.mockImplementation(
    async (_ptyId: string, type: string, payload: { laneId?: string; reason?: string }) => {
      if (type === 'podLaneGrant') {
        grants += 1
        return {
          laneId: `lane-${seed}-${grants}`,
          socketPath: '/tmp/x/pod-lane-v44.sock',
          token: 't'
        }
      }
      if (type === 'podLaneRevoke' && payload.laneId) {
        daemon.ops.push({ kind: 'revoke', laneId: payload.laneId, reason: payload.reason })
      }
      return true
    }
  )
  const harness = startLaneHarness({
    serializeTerminalBuffer: vi.fn(async () => ({
      data: mainLines.map(lineText).join(''),
      cols: 120,
      rows: 40,
      seq: mainLines.length * LINE
    }))
  })
  await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
  sendDesktopMultiplexSubscribe(harness.handlers)
  let viewer = new Viewer(harness, daemon)
  const violations: string[] = []
  let switches = 0
  let relaunches = 0
  const mainStep = () => {
    const event = daemon.mainInbox.shift()
    if (event?.kind === 'data') {
      mainLines.push(event.line)
      harness.push(lineText(event.line), { seq: (event.line + 1) * LINE })
    } else if (event) {
      const { laneId, phase, reason } = event
      handlePodLaneEvent({ id: 'pty-1', kind: 'podLane', laneId, phase, reason })
    }
  }
  const laneStep = () => {
    const frame = daemon.laneFrames.shift()
    if (frame) {
      viewer.stepLane(frame)
    }
  }
  const opStep = () => {
    const op = daemon.ops.shift()
    if (op) {
      daemon.runOp(op)
    }
  }
  for (let step = 0; switches + viewer.switches < targetSwitches && step < 60_000; step++) {
    const roll = random() * 100
    if (roll < 14) {
      daemon.emit()
    } else if (roll < 40) {
      mainStep()
    } else if (roll < 60) {
      viewer.stepStream()
    } else if (roll < 80) {
      laneStep()
    } else if (roll < 92) {
      opStep()
    } else if (roll < 96) {
      if (viewer.wantsLane) {
        await viewer.requestLane()
      }
    } else if (roll < 97.2) {
      // A gap the viewer saw (PodNative asks for a snapshot without an id).
      viewer.requestSnapshot()
    } else if (roll < 97.8) {
      if (daemon.tap) {
        daemon.close(daemon.tap, 'backpressure')
      }
    } else if (roll < 98.4) {
      viewer.closeLane()
    } else if (roll < 98.48) {
      // Quit and relaunch: this viewer's stream and lane end, a new viewer attaches.
      violations.push(...viewer.violations)
      switches += viewer.switches
      relaunches += 1
      viewer.closeLane()
      harness.slot(TerminalStreamOpcode.Unsubscribe, {})
      await settle()
      viewer = new Viewer(harness, daemon)
      sendDesktopMultiplexSubscribe(harness.handlers)
    }
    await settle()
  }
  // Drain: the PTY stops, and everything in flight lands.
  for (let round = 0; round < 2_000; round++) {
    const busy =
      daemon.mainInbox.length + daemon.laneFrames.length + daemon.ops.length > 0 ||
      viewer.framesSeen < harness.frames.length
    if (!busy && round > 50) {
      break
    }
    mainStep()
    opStep()
    laneStep()
    while (viewer.stepStream()) {}
    await settle()
  }
  violations.push(...viewer.violations)
  return {
    switches: switches + viewer.switches,
    relaunches,
    violations,
    emitted: daemon.emitted,
    screen: viewer.screen
  }
}

beforeEach(() => {
  // Why: the lane is macOS-only; these tests model a Mac on every host (Linux CI included).
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  control.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('stream/lane seam', () => {
  it.each([1, 2, 3, 4])(
    'loses and repeats no line across 50 switches, snapshot requests and relaunches (seed %i)',
    async (seed) => {
      const result = await runSeam(seed, 50)
      expect(result.violations).toEqual([])
      expect(result.switches).toBeGreaterThanOrEqual(50)
      expect(result.screen).toEqual(Array.from({ length: result.emitted }, (_, index) => index))
    },
    60_000
  )
})
