import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// brew's claude-acc-setup and install.sh install the menu app here, carrying the install's version
const INSTALLED_APP_PLIST = 'Applications/Claude Acc.app/Contents/Info.plist'

/** The version of a claude-acc installed outside Pod, from its menu app; null when there is none. */
export function readInstalledAppVersion(home: string): string | null {
  try {
    const plist = readFileSync(join(home, INSTALLED_APP_PLIST), 'utf8')
    const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)
    return match ? match[1].trim() : null
  } catch {
    return null
  }
}

/** Dotted numeric versions ("1.31.15"); null when either is not one, so nothing is ordered
 *  (the lifecycle then keeps what is installed). */
export function compareAccVersions(a: string, b: string): number | null {
  const parse = (version: string): number[] | null =>
    /^\d+(\.\d+){0,3}$/.test(version) ? version.split('.').map(Number) : null
  const left = parse(a)
  const right = parse(b)
  if (!left || !right) {
    return null
  }
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) {
      return Math.sign(diff)
    }
  }
  return 0
}
