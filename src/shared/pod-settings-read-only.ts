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

// What terminalThemeDark/Light take (pod-settings-schema.ts), and a name's bound.
const MAX_THEME_SELECTION = 256
const MAX_THEME_NAME = 256

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
            selection: z.string().max(MAX_THEME_SELECTION),
            name: z.string().max(MAX_THEME_NAME),
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
    terminalCustomThemes: normalizeTerminalCustomThemes(settings.terminalCustomThemes)
      .map((theme) => ({
        selection: makeCustomTerminalThemeSelection(theme.id),
        // By code points, so no surrogate pair is cut in half.
        name: [...theme.name].slice(0, MAX_THEME_NAME).join(''),
        source: theme.source
      }))
      // A selection the theme fields refuse is no choice.
      .filter((theme) => theme.selection.length <= MAX_THEME_SELECTION)
  }
}
