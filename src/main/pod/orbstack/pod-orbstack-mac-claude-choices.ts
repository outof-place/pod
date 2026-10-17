// Fork-only (Pod): what the Mac's user already chose in Claude Code, so a sandboxed Claude opens on
// its prompt as on the Mac: the theme, and the accepted bypass-permissions warning.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveClaudeGlobalConfigFile } from '../../claude/claude-folder-trust-file'

/** Only these values cross into a sandbox; nothing that authenticates or points elsewhere. */
export type SandboxClaudeChoices = {
  /** A built-in theme name; a custom theme becomes the built-in it's based on. */
  theme: string | null
  /** The user accepted the bypass-permissions warning on the Mac (Claude writes it on accept). */
  skipDangerousModePermissionPrompt: boolean
}

export const NO_SANDBOX_CLAUDE_CHOICES: SandboxClaudeChoices = {
  theme: null,
  skipDangerousModePermissionPrompt: false
}

// Why a shape, not a list: Claude Code names its own themes; only a plain word is copied.
const THEME_SHAPE = /^[a-z][a-z-]{0,31}$/
const CUSTOM_THEME = /^custom:([\w.-]{1,64})$/

type Read = (path: string) => string

function readJsonObject(read: Read, path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(read(path))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? { ...parsed }
      : {}
  } catch {
    return {}
  }
}

function builtInTheme(value: unknown, configDir: string, read: Read): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const custom = CUSTOM_THEME.exec(value)
  // A custom theme's file stays on the Mac; the sandbox gets the preset it overrides.
  const theme = custom
    ? readJsonObject(read, join(configDir, 'themes', `${custom[1]}.json`)).base
    : value
  return typeof theme === 'string' && THEME_SHAPE.test(theme) ? theme : null
}

/**
 * Reads `theme` and `skipDangerousModePermissionPrompt` from the Mac's user settings (and a theme
 * from the legacy ~/.claude.json), following CLAUDE_CONFIG_DIR as Claude Code does.
 */
export function readMacClaudeChoices(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir(),
  read: Read = (path) => readFileSync(path, 'utf8')
): SandboxClaudeChoices {
  const configDir = env.CLAUDE_CONFIG_DIR || join(homeDir, '.claude')
  const settings = readJsonObject(read, join(configDir, 'settings.json'))
  const legacy = readJsonObject(
    read,
    resolveClaudeGlobalConfigFile({
      env: {
        CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR,
        CLAUDE_CODE_CUSTOM_OAUTH_URL: env.CLAUDE_CODE_CUSTOM_OAUTH_URL
      },
      homeDir,
      style: 'posix',
      exists: existsSync
    })
  )
  return {
    theme:
      builtInTheme(settings.theme, configDir, read) ?? builtInTheme(legacy.theme, configDir, read),
    skipDangerousModePermissionPrompt: settings.skipDangerousModePermissionPrompt === true
  }
}
