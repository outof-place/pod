// Fork-only (Pod): the direct terminal lane between PodNative and the terminal daemon. One terminal's
// bytes skip Electron main; main keeps ownership, layout, auth and its bookkeeping. Frames on the
// lane socket: type u8, payload length u32 big-endian, payload. Design: PodNative README, "Direct
// terminal lane".

export const POD_LANE_PROTOCOL_VERSION = 1
export const POD_LANE_FRAME_HEADER_BYTES = 5
/** The most one input frame carries; main's terminal writes cap a send at the same size. */
export const POD_LANE_MAX_INPUT_BYTES = 16 * 1024 * 1024
export const POD_LANE_MAX_HELLO_BYTES = 1024
export const POD_LANE_TOKEN_BYTES = 32

/** Client to daemon. */
export const PodLaneClientFrame = {
  /** JSON `{v, laneId, token}`; the first frame, and only once. */
  Hello: 1,
  /** UTF-8 input for the PTY, never split inside a character. */
  Input: 2,
  /** u64 big-endian k: input after this frame waits until main settles viewport claim k. */
  Fence: 3
} as const

/** Daemon to client. */
export const PodLaneServerFrame = {
  /** JSON `{v, sessionId}`: the lane carries every PTY chunk after main's switch marker. */
  Ready: 1,
  /** UTF-8 output, the same bytes main's stream gets, before the daemon's emulator parses them. */
  Output: 2,
  /** JSON `{code}`: the PTY exited; the lane closes next. */
  Exit: 3,
  /** JSON `{reason}`: the lane is over; the multiplex stream takes over again. */
  Closed: 4,
  /** JSON `{bytes, reason}`: input dropped by policy (a phone drives, or a viewport claim failed). */
  Dropped: 5
} as const

export type PodLaneHello = { v: number; laneId: string; token: string }

export type PodLaneFrame = { type: number; payload: Buffer }

export function encodePodLaneFrame(type: number, payload: Uint8Array = new Uint8Array()): Buffer {
  const frame = Buffer.allocUnsafe(POD_LANE_FRAME_HEADER_BYTES + payload.byteLength)
  frame.writeUInt8(type, 0)
  frame.writeUInt32BE(payload.byteLength, 1)
  frame.set(payload, POD_LANE_FRAME_HEADER_BYTES)
  return frame
}

export function encodePodLaneJson(type: number, value: unknown): Buffer {
  return encodePodLaneFrame(type, Buffer.from(JSON.stringify(value), 'utf8'))
}

export function encodePodLaneFence(fence: number): Buffer {
  const payload = Buffer.alloc(8)
  payload.writeBigUInt64BE(BigInt(fence))
  return encodePodLaneFrame(PodLaneClientFrame.Fence, payload)
}

export class PodLaneFrameTooLargeError extends Error {
  constructor(readonly length: number) {
    super(`pod lane frame too large: ${length} bytes`)
  }
}

/** Splits a byte stream into frames; a frame over `maxPayloadBytes` throws before it is buffered. */
export class PodLaneFrameReader {
  private buffered: Buffer = Buffer.alloc(0)

  /** Raised once the peer is authenticated: a hello is small, input can be a paste. */
  constructor(public maxPayloadBytes: number) {}

  push(chunk: Buffer): PodLaneFrame[] {
    this.buffered = this.buffered.length === 0 ? chunk : Buffer.concat([this.buffered, chunk])
    const frames: PodLaneFrame[] = []
    let offset = 0
    while (this.buffered.length - offset >= POD_LANE_FRAME_HEADER_BYTES) {
      const length = this.buffered.readUInt32BE(offset + 1)
      if (length > this.maxPayloadBytes) {
        throw new PodLaneFrameTooLargeError(length)
      }
      const end = offset + POD_LANE_FRAME_HEADER_BYTES + length
      if (this.buffered.length < end) {
        break
      }
      frames.push({
        type: this.buffered.readUInt8(offset),
        payload: this.buffered.subarray(offset + POD_LANE_FRAME_HEADER_BYTES, end)
      })
      offset = end
    }
    this.buffered =
      offset === this.buffered.length ? Buffer.alloc(0) : this.buffered.subarray(offset)
    return frames
  }
}
