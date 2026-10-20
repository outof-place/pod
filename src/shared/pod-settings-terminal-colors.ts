// Fork-only (Pod): the terminal color overrides as a podSettings field.
import { z } from 'zod'
import { row } from './pod-settings-row'
import { TERMINAL_COLOR_KEYS, normalizeTerminalHexColor } from './terminal-custom-themes'

// Stored as #rrggbb, the renderer's own normalizer; anything else is refused, not dropped.
const terminalHexColor = z
  .string()
  .max(16)
  .transform((value, ctx) => {
    const color = normalizeTerminalHexColor(value)
    if (color === null) {
      ctx.addIssue({ code: 'custom', message: 'Not a hex color' })
      return z.NEVER
    }
    return color
  })

/** Written whole ({} clears them); a theme picked over podSettings.set clears them too. */
export const TERMINAL_COLOR_OVERRIDES_FIELD = row(
  z.partialRecord(z.enum(TERMINAL_COLOR_KEYS), terminalHexColor),
  'Color overrides',
  "Colors over the theme's own. Picking another theme clears them."
)
