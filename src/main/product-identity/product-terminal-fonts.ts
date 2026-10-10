// Fork-only (Pod): macOS keeps SF Mono inside Terminal.app's bundle. The renderer declares those
// faces itself (pod/overlay); Ghostty's CoreText lookup in this process needs them registered,
// or "SF Mono" silently falls back to Menlo. Process scope only: the font library is untouched.
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getProductIdentity } from './product-identity'

const TERMINAL_APP_FONT_DIRS = [
  '/System/Applications/Utilities/Terminal.app/Contents/Resources/Fonts',
  // Why: Terminal.app sat here before macOS 10.15 moved system apps under /System.
  '/Applications/Utilities/Terminal.app/Contents/Resources/Fonts'
]
const SF_MONO_FILE = /^SF-Mono-[A-Za-z]+\.otf$/

export type ProductTerminalFontFs = {
  exists: (path: string) => boolean
  list: (dir: string) => string[]
}

const nodeFs: ProductTerminalFontFs = {
  exists: existsSync,
  list: (dir) => readdirSync(dir)
}

/** Terminal.app's SF Mono files, or none when SF Mono is installed where CoreText already looks. */
export function productTerminalFontFiles(
  home = homedir(),
  fs: ProductTerminalFontFs = nodeFs
): string[] {
  const installed = [join(home, 'Library', 'Fonts'), '/Library/Fonts'].some((dir) =>
    fs.exists(join(dir, 'SF-Mono-Regular.otf'))
  )
  if (installed) {
    return []
  }
  const dir = TERMINAL_APP_FONT_DIRS.find((candidate) => fs.exists(candidate))
  if (!dir) {
    return []
  }
  return fs
    .list(dir)
    .filter((name) => SF_MONO_FILE.test(name))
    .sort()
    .map((name) => join(dir, name))
}

/** Registers SF Mono for Ghostty before its first config load; a no-op outside a macOS product. */
export function registerProductTerminalFonts(addon: {
  registerProcessFonts?: (paths: string[]) => number
}): void {
  if (process.platform !== 'darwin' || !getProductIdentity()) {
    return
  }
  const files = productTerminalFontFiles()
  if (files.length > 0) {
    addon.registerProcessFonts?.(files)
  }
}
