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
    sourceControlAi: z.object({ enabled: z.boolean() }).strict()
  })
  .strict()

export type PodSettingsReadOnly = z.output<typeof PodSettingsReadOnlySchema>

export const POD_SETTINGS_READ_ONLY_KEYS = [
  'openLinksInApp',
  'openLinksInAppModifierInverts',
  'sourceControlAi'
] as const satisfies readonly (keyof GlobalSettings & keyof PodSettingsReadOnly)[]

export type PodSettingsReadOnlyKey = (typeof POD_SETTINGS_READ_ONLY_KEYS)[number]

/** The values as the desktop reads them: unset is off, and source control AI as migrated. */
export function projectPodSettingsReadOnly(
  settings: Partial<Pick<GlobalSettings, PodSettingsReadOnlyKey | 'commitMessageAi'>>
): PodSettingsReadOnly {
  return {
    openLinksInApp: settings.openLinksInApp === true,
    openLinksInAppModifierInverts: settings.openLinksInAppModifierInverts === true,
    sourceControlAi: {
      enabled: normalizeSourceControlAiSettings(settings.sourceControlAi, settings.commitMessageAi)
        .enabled
    }
  }
}
