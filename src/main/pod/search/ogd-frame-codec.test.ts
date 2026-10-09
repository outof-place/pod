import { describe, expect, it } from 'vitest'
import {
  encodeOgdFrame,
  encodeOgdJsonFrame,
  OGD_FRAME_BINARY,
  OGD_FRAME_JSON,
  OGD_MAX_FRAME_BYTES,
  OgdFrameDecoder,
  OgdProtocolError
} from './ogd-frame-codec'

describe('ogd frame codec', () => {
  it('writes a little-endian length that counts the kind byte and the payload', () => {
    const frame = encodeOgdJsonFrame({ op: 'status', id: 6 })
    const payload = Buffer.from('{"op":"status","id":6}')
    expect(frame.readUInt32LE(0)).toBe(payload.length + 1)
    expect(frame[4]).toBe(OGD_FRAME_JSON)
    expect(frame.subarray(5)).toEqual(payload)
  })

  it('reassembles frames split at every byte and several frames in one chunk', () => {
    const stream = Buffer.concat([
      encodeOgdJsonFrame({ id: 1, ok: true, bin: 3 }),
      encodeOgdFrame(OGD_FRAME_BINARY, Buffer.from('a\nb')),
      encodeOgdJsonFrame({ id: 2, ok: true })
    ])
    const byteByByte = new OgdFrameDecoder()
    const frames = [...stream].flatMap((byte) => byteByByte.push(Buffer.from([byte])))
    const whole = new OgdFrameDecoder().push(stream)
    for (const decoded of [frames, whole]) {
      expect(decoded.map((frame) => frame.kind)).toEqual([
        OGD_FRAME_JSON,
        OGD_FRAME_BINARY,
        OGD_FRAME_JSON
      ])
      expect(decoded[1].payload.toString()).toBe('a\nb')
      expect(JSON.parse(decoded[2].payload.toString())).toEqual({ id: 2, ok: true })
    }
  })

  it('rejects a zero or oversized length instead of buffering forever', () => {
    const zero = Buffer.alloc(4)
    expect(() => new OgdFrameDecoder().push(zero)).toThrow(OgdProtocolError)
    const huge = Buffer.alloc(4)
    huge.writeUInt32LE(OGD_MAX_FRAME_BYTES + 1, 0)
    expect(() => new OgdFrameDecoder().push(huge)).toThrow(OgdProtocolError)
  })
})
