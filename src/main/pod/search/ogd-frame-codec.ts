// ogd protocol v1 framing: u32 little-endian length (bytes after itself), u8 kind, payload.
export const OGD_FRAME_JSON = 0x01
export const OGD_FRAME_BINARY = 0x02
export const OGD_MAX_FRAME_BYTES = 256 * 1024 * 1024

const HEADER_BYTES = 4

export type OgdFrame = { kind: number; payload: Buffer }

export class OgdProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OgdProtocolError'
  }
}

export function encodeOgdFrame(kind: number, payload: Buffer): Buffer {
  if (payload.length + 1 > OGD_MAX_FRAME_BYTES) {
    throw new OgdProtocolError(`ogd frame of ${payload.length} bytes exceeds the protocol limit`)
  }
  const frame = Buffer.allocUnsafe(HEADER_BYTES + 1 + payload.length)
  frame.writeUInt32LE(payload.length + 1, 0)
  frame.writeUInt8(kind, HEADER_BYTES)
  payload.copy(frame, HEADER_BYTES + 1)
  return frame
}

export function encodeOgdJsonFrame(message: Record<string, unknown>): Buffer {
  return encodeOgdFrame(OGD_FRAME_JSON, Buffer.from(JSON.stringify(message), 'utf8'))
}

/** Splits a byte stream into frames; chunks are joined once per complete frame, not per read. */
export class OgdFrameDecoder {
  private chunks: Buffer[] = []
  private buffered = 0

  push(chunk: Buffer): OgdFrame[] {
    if (chunk.length > 0) {
      this.chunks.push(chunk)
      this.buffered += chunk.length
    }
    const frames: OgdFrame[] = []
    while (this.buffered >= HEADER_BYTES) {
      const length = this.peekLength()
      if (length < 1 || length > OGD_MAX_FRAME_BYTES) {
        throw new OgdProtocolError(`ogd frame length ${length} is out of range`)
      }
      if (this.buffered < HEADER_BYTES + length) {
        break
      }
      const frame = this.take(HEADER_BYTES + length)
      frames.push({ kind: frame[HEADER_BYTES], payload: frame.subarray(HEADER_BYTES + 1) })
    }
    return frames
  }

  private peekLength(): number {
    if (this.chunks[0].length < HEADER_BYTES) {
      this.chunks = [Buffer.concat(this.chunks, this.buffered)]
    }
    return this.chunks[0].readUInt32LE(0)
  }

  private take(bytes: number): Buffer {
    const joined =
      this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.buffered)
    const rest = joined.subarray(bytes)
    this.chunks = rest.length > 0 ? [rest] : []
    this.buffered = rest.length
    return joined.subarray(0, bytes)
  }
}
