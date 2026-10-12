// Fork-only (Pod): what main tells the daemon it spawns about Claude's hook relay.
import { isPodClaudeFlagSettingsEnabled } from '../../pod/agent-hook/pod-claude-flag-gate'

export function podClaudeHookDaemonEnv(): NodeJS.ProcessEnv {
  // = POD_CLAUDE_HOOK_RELAY_ENV; main doesn't load the daemon's relay module.
  return isPodClaudeFlagSettingsEnabled() ? { POD_CLAUDE_HOOK_RELAY: '1' } : {}
}
