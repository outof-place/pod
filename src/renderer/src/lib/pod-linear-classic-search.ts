// Fork-only (Pod): without the classic Linear card, Settings search and ⌘J don't offer Linear under
// Integrations; PodNative is Linear's only UI.
import { translate } from '@/i18n/i18n'
import { POD_LINEAR_CLASSIC_UI } from '../../../shared/product/features'
import type { SettingsNavSection } from './settings-navigation-types'

export function withoutClassicLinearSearch(sections: SettingsNavSection[]): SettingsNavSection[] {
  if (POD_LINEAR_CLASSIC_UI) {
    return sections
  }
  return sections.map((section) =>
    section.id === 'integrations'
      ? {
          ...section,
          description: translate(
            'podLinear.integrations.description',
            'Connect GitHub, GitLab, and source-hosting services.'
          ),
          searchEntries: section.searchEntries.filter(
            (entry) => !entry.keywords?.includes('linear')
          )
        }
      : section
  )
}

/** ⌘J's aliases for a settings section, without "linear". */
export function withoutClassicLinearAliases(aliases: string[]): string[] {
  return POD_LINEAR_CLASSIC_UI ? aliases : aliases.filter((alias) => alias !== 'linear')
}
