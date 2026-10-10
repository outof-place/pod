import { describe, expect, it, vi } from 'vitest'

const createFromBitmapMock = vi.hoisted(() =>
  vi.fn((buffer: Buffer, options: { width: number; height: number }) => ({
    __image: true,
    buffer,
    ...options
  }))
)

vi.mock('electron', () => ({
  nativeImage: { createFromBitmap: createFromBitmapMock }
}))

import { stampTrayDevBadge } from './tray-dev-badge'

const GLYPH_ALPHA = 0x80

function fakeTemplate(width: number, height: number) {
  // All-transparent base so any opaque pixel in the result is the badge, except
  // one half-alpha glyph pixel in the top-left corner that must move unchanged.
  return {
    getSize: () => ({ width, height }),
    toBitmap: vi.fn((options?: { scaleFactor?: number }) => {
      const scale = options?.scaleFactor ?? 1
      const bitmap = Buffer.alloc(width * scale * height * scale * 4, 0)
      bitmap[3] = GLYPH_ALPHA
      return bitmap
    })
  }
}

describe('stampTrayDevBadge', () => {
  it('returns the base unchanged when it has no pixels', () => {
    createFromBitmapMock.mockClear()
    const base = { getSize: () => ({ width: 0, height: 0 }), toBitmap: () => Buffer.alloc(0) }

    expect(stampTrayDevBadge(base as never)).toBe(base)
    expect(createFromBitmapMock).not.toHaveBeenCalled()
  })

  it('widens the canvas, keeps the glyph and stamps opaque template-black pixels left of it', () => {
    createFromBitmapMock.mockClear()
    const width = 18
    const height = 18
    stampTrayDevBadge(fakeTemplate(width, height) as never)

    const [bitmap, options] = createFromBitmapMock.mock.calls[0]
    const stampedWidth = options.width
    expect(options.height).toBe(height)
    expect(stampedWidth).toBeGreaterThan(width)
    const badgeColumns = stampedWidth - width
    // The glyph moves right by the badge columns, untouched.
    expect(bitmap[badgeColumns * 4 + 3]).toBe(GLYPH_ALPHA)

    let stamped = 0
    let maxX = 0
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < stampedWidth; x++) {
        const o = (y * stampedWidth + x) * 4
        if (bitmap[o + 3] === 0xff) {
          expect([bitmap[o], bitmap[o + 1], bitmap[o + 2]]).toEqual([0x00, 0x00, 0x00])
          stamped++
          maxX = Math.max(maxX, x)
        }
      }
    }
    expect(stamped).toBeGreaterThan(0)
    // The badge stays in its own columns, clear of the glyph.
    expect(maxX).toBeLessThan(badgeColumns)
  })

  it('reads and scales the requested Retina representation', () => {
    const opaque = (buffer: Buffer): number => {
      let count = 0
      for (let o = 3; o < buffer.length; o += 4) {
        if (buffer[o] === 0xff) {
          count++
        }
      }
      return count
    }

    createFromBitmapMock.mockClear()
    const base = fakeTemplate(22, 14)
    stampTrayDevBadge(base as never, 2)
    expect(base.toBitmap).toHaveBeenCalledWith({ scaleFactor: 2 })
    const [bitmap2x, options2x] = createFromBitmapMock.mock.calls[0]

    createFromBitmapMock.mockClear()
    stampTrayDevBadge(fakeTemplate(22, 14) as never, 1)
    const [bitmap1x, options1x] = createFromBitmapMock.mock.calls[0]

    expect(options2x).toEqual({ width: options1x.width * 2, height: 28 })

    // Each 1x badge pixel becomes a 2x2 block, so the @2x stamp has 4x the area.
    expect(opaque(bitmap2x)).toBe(opaque(bitmap1x) * 4)
  })
})
