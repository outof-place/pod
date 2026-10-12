// Fork-only (Pod): settings a native Pod client follows but never edits; Pod's own window owns
// them. podSettings.get and subscribe carry them in `readOnly`, settings.get beside its own
// fields (pod-client-settings-extras.ts), and podSettings.set refuses them.
import { z } from 'zod'
import type { GlobalSettings } from './global-settings-types'
import { normalizeSourceControlAiSettings } from './source-control-ai-settings'

export const PodSettingsReadOnlySchema = z
  .object({
    // Where a terminal's web link opens: Pod's own browser, Shift the other way when it inverts.
    openLinksInApp: z.boolean(),
    openLinksInAppModifierInverts: z.boolean(),
    // Whether source control's AI actions are on (acc-native's commit and PR buttons).
    sourceControlAi: z.object({ enabled: z.boolean() }).strict(),
    // Claude's prompt cache countdown after an agent goes idle, and how long the cache lives.
    promptCacheTimerEnabled: z.boolean(),
    promptCacheTtlMs: z.number().int().positive()
  })
  .strict()

export type PodSettingsReadOnly = z.output<typeof PodSettingsReadOnlySchema>

export const POD_SETTINGS_READ_ONLY_KEYS = [
  'openLinksInApp',
  'openLinksInAppModifierInverts',
  'sourceControlAi',
  'promptCacheTimerEnabled',
  'promptCacheTtlMs'
] as const satisfies readonly (keyof GlobalSettings & keyof PodSettingsReadOnly)[]

export type PodSettingsReadOnlyKey = (typeof POD_SETTINGS_READ_ONLY_KEYS)[number]

// Pod's default cache lifetime (default-global-settings.ts).
const DEFAULT_PROMPT_CACHE_TTL_MS = 300_000

/** The values as the desktop reads them: unset is off, and source control AI as migrated. */
export function projectPodSettingsReadOnly(
  settings: Partial<Pick<GlobalSettings, PodSettingsReadOnlyKey | 'commitMessageAi'>>
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
        : DEFAULT_PROMPT_CACHE_TTL_MS
  }
}
