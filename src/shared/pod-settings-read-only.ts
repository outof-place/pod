// Fork-only (Pod): a mirror of settings PodNative before R1 followed but never edited. They are
// podSettings fields now; podSettings.get and subscribe still carry the mirror in `readOnly`, and
// settings.get beside its own fields (pod-client-settings-extras.ts), so those clients keep working.
// Also the custom terminal themes, which only the classic window's imports make.
import { z } from 'zod'
import type { GlobalSettings } from './global-settings-types'
import { normalizeSourceControlAiSettings } from './source-control-ai-settings'
import {
  MAX_TERMINAL_CUSTOM_THEMES,
  makeCustomTerminalThemeSelection,
  normalizeTerminalCustomThemes
} from './terminal-custom-themes'

export const PodSettingsReadOnlySchema = z
  .object({
    // Where a terminal's web link opens: Pod's own browser, Shift the other way when it inverts.
    openLinksInApp: z.boolean(),
    openLinksInAppModifierInverts: z.boolean(),
    // Whether source control's AI actions are on (acc-native's commit and PR buttons).
    sourceControlAi: z.object({ enabled: z.boolean() }).strict(),
    // Claude's prompt cache countdown after an agent goes idle, and how long the cache lives.
    promptCacheTimerEnabled: z.boolean(),
    promptCacheTtlMs: z.number().int().positive(),
    // A theme picker's imported themes: `selection` is what terminalThemeDark/Light take.
    terminalCustomThemes: z
      .array(
        z
          .object({
            selection: z.string(),
            name: z.string(),
            source: z.enum(['warp', 'ghostty', 'manual'])
          })
          .strict()
      )
      .max(MAX_TERMINAL_CUSTOM_THEMES)
  })
  .strict()

export type PodSettingsReadOnly = z.output<typeof PodSettingsReadOnlySchema>

type MirroredKey = keyof PodSettingsReadOnly

// Pod's default cache lifetime (default-global-settings.ts).
const DEFAULT_PROMPT_CACHE_TTL_MS = 300_000

/** The values as the desktop reads them: unset is off, and source control AI as migrated. */
export function projectPodSettingsReadOnly(
  settings: Partial<Pick<GlobalSettings, MirroredKey | 'commitMessageAi'>>
): PodSettingsReadOnly {
  const ttl = settings.promptCacheTtlMs
  return {
    openLinksInApp: settings.openLinksInApp === true,
    openLinksInAppModifierInverts: settings.openLinksInAppModifierInverts === true,
    sourceControlAi: {
      enabled: normalizeSourceControlAiSettings(settings.sourceControlAi, settings.commitMessageAi)
        .enabled
    },
    promptCacheTimerEnabled: settings.promptCacheTimerEnabled === true,
    promptCacheTtlMs:
      typeof ttl === 'number' && Number.isInteger(ttl) && ttl > 0
        ? ttl
        : DEFAULT_PROMPT_CACHE_TTL_MS,
    terminalCustomThemes: normalizeTerminalCustomThemes(settings.terminalCustomThemes).map(
      (theme) => ({
        selection: makeCustomTerminalThemeSelection(theme.id),
        name: theme.name,
        source: theme.source
      })
    )
  }
}
