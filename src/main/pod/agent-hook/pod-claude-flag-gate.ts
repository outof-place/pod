// Fork-only (Pod): whether Pod hands Claude its hooks with `--settings` (pod-claude-flag-settings.ts).
import { getProductIdentity } from '../../product-identity/product-identity'

function hasPodProductIdentity(): boolean {
  try {
    return getProductIdentity() !== null
  } catch {
    // A malformed identity file fails startup elsewhere; it must not also crash a hook install.
    return false
  }
}

/** Pod builds on macOS only. `POD_CLAUDE_FLAG_SETTINGS=0|1` overrides the identity, for tests. */
export function isPodClaudeFlagSettingsEnabled(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  hasIdentity: () => boolean = hasPodProductIdentity
): boolean {
  if (platform !== 'darwin' || env.POD_CLAUDE_FLAG_SETTINGS === '0') {
    return false
  }
  return env.POD_CLAUDE_FLAG_SETTINGS === '1' || hasIdentity()
}
