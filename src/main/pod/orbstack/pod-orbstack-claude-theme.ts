// Fork-only (Pod): the Mac's Claude Code theme, so a sandboxed Claude opens in the colors the user picked.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolveClaudeGlobalConfigFile } from '../../claude/claude-folder-trust-file'

// Why a shape, not a list: Claude Code names its own themes; only a plain word is copied.
const THEME_SHAPE = /^[a-z][a-z-]{0,31}$/

/** Reads only `theme` from the Mac's ~/.claude.json; null when unset, unreadable or odd. */
export function readMacClaudeTheme(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir(),
  read: (path: string) => string = (path) => readFileSync(path, 'utf8')
): string | null {
  try {
    const file = resolveClaudeGlobalConfigFile({
      env: {
        CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR,
        CLAUDE_CODE_CUSTOM_OAUTH_URL: env.CLAUDE_CODE_CUSTOM_OAUTH_URL
      },
      homeDir,
      style: 'posix',
      exists: existsSync
    })
    const parsed: unknown = JSON.parse(read(file))
    const theme =
      typeof parsed === 'object' && parsed !== null && 'theme' in parsed ? parsed.theme : null
    return typeof theme === 'string' && THEME_SHAPE.test(theme) ? theme : null
  } catch {
    return null
  }
}
