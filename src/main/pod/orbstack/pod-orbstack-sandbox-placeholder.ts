// Fork-only (Pod): the credential placeholder a sandbox's Claude Code sends, checked before Pod
// attaches the real credential.
import { timingSafeEqual } from 'node:crypto'

/**
 * Why: OrbStack forwards a machine's loopback listeners to the Mac's localhost, isolated machines
 * included, so the route's 443 listener in the VM may be reachable from any local process. Only the
 * sandbox's own Claude Code knows its placeholder (random, in Pod's memory and the agent's env).
 */
export function carriesSandboxPlaceholder(
  rawHeaders: readonly string[],
  placeholder: string | null
): boolean {
  if (!placeholder) {
    return false
  }
  const bearer = Buffer.from(`Bearer ${placeholder}`)
  const key = Buffer.from(placeholder)
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = (rawHeaders[i] ?? '').toLowerCase()
    const expected = name === 'authorization' ? bearer : name === 'x-api-key' ? key : null
    const value = Buffer.from(rawHeaders[i + 1] ?? '')
    if (expected && value.length === expected.length && timingSafeEqual(value, expected)) {
      return true
    }
  }
  return false
}
