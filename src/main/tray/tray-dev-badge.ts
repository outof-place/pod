import { nativeImage, type NativeImage } from 'electron'

// Why: a 5px-tall pixel-caps "DEV" is the smallest text that stays legible in
// the menu-bar template.
const DEV_BADGE_ROWS = ['##..###.#.#', '#.#.#...#.#', '#.#.##..#.#', '#.#.#...#.#', '##..###..#.']
// Why columns of its own: Pod's mark fills its square template and leaves no
// empty area for the badge, so a dev status item is this much wider instead.
const BADGE_GAP = 2
const BADGE_COLUMNS = DEV_BADGE_ROWS[0].length + BADGE_GAP

/**
 * Returns a copy of the menu-bar template with a "DEV" pixel-text badge in new
 * columns left of the glyph. Badge pixels are template black (#000 + alpha),
 * so macOS tints them with the glyph in both menu-bar themes and the attention
 * tint path inherits the badge unchanged. Returns `base` untouched when the
 * image has no pixels.
 */
export function stampTrayDevBadge(base: NativeImage, scaleFactor = 1): NativeImage {
  const { width, height } = base.getSize()
  if (width <= 0 || height <= 0) {
    return base
  }

  const source = Buffer.from(base.toBitmap({ scaleFactor }))
  const sourceRowBytes = width * scaleFactor * 4
  const pixelWidth = (width + BADGE_COLUMNS) * scaleFactor
  const pixelHeight = height * scaleFactor
  const bitmap = Buffer.alloc(pixelWidth * pixelHeight * 4, 0)
  for (let y = 0; y < pixelHeight; y++) {
    source.copy(
      bitmap,
      (y * pixelWidth + BADGE_COLUMNS * scaleFactor) * 4,
      y * sourceRowBytes,
      (y + 1) * sourceRowBytes
    )
  }

  const offsetY = Math.max(0, Math.floor((height - DEV_BADGE_ROWS.length) / 2))
  for (let row = 0; row < DEV_BADGE_ROWS.length; row++) {
    const pattern = DEV_BADGE_ROWS[row]
    for (let col = 0; col < pattern.length; col++) {
      if (pattern[col] !== '#') {
        continue
      }
      // Why: replicate each badge pixel scaleFactor times so the Retina
      // representation shows the same physical badge as the 1x one.
      for (let dy = 0; dy < scaleFactor; dy++) {
        for (let dx = 0; dx < scaleFactor; dx++) {
          const x = col * scaleFactor + dx
          const y = (offsetY + row) * scaleFactor + dy
          if (y >= pixelHeight) {
            continue
          }
          const offset = (y * pixelWidth + x) * 4
          bitmap[offset] = 0x00
          bitmap[offset + 1] = 0x00
          bitmap[offset + 2] = 0x00
          bitmap[offset + 3] = 0xff
        }
      }
    }
  }

  return nativeImage.createFromBitmap(bitmap, { width: pixelWidth, height: pixelHeight })
}
