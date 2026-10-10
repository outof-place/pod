// Fork-only (Pod): the Settings sidebar entry for OrbStack, without pane UI imports.
import { Container } from 'lucide-react'
import { searchKeywords } from '@/components/settings/settings-search-keywords'
import type { SettingsSearchEntry } from '@/components/settings/settings-search'
import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import type { SettingsNavSection } from '@/lib/settings-navigation-types'

export const POD_ORBSTACK_SETTINGS_SECTION_ID = 'pod-orbstack'

export function getPodOrbstackSettingsTitle(): string {
  return translate('podOrbstack.section.title', 'OrbStack')
}

export function getPodOrbstackSettingsDescription(): string {
  return translate(
    'podOrbstack.section.description',
    'Linux machines and Docker containers from OrbStack, and a machine per worktree.'
  )
}

export const getPodOrbstackSearchEntries = createLocalizedCatalog((): SettingsSearchEntry[] => [
  {
    title: getPodOrbstackSettingsTitle(),
    description: getPodOrbstackSettingsDescription(),
    keywords: searchKeywords([
      { key: 'podOrbstack.search.orbstack', fallback: 'OrbStack', englishOnly: true },
      { key: 'podOrbstack.search.docker', fallback: 'Docker', englishOnly: true },
      { key: 'podOrbstack.search.containers', fallback: 'containers' },
      { key: 'podOrbstack.search.machines', fallback: 'Linux machines' },
      { key: 'podOrbstack.search.vm', fallback: 'virtual machine' },
      { key: 'podOrbstack.search.context', fallback: 'docker context' }
    ])
  }
])

export function buildPodOrbstackSettingsSections(options: {
  podOrbstackEnabled?: boolean
}): SettingsNavSection[] {
  if (options.podOrbstackEnabled !== true) {
    return []
  }
  return [
    {
      id: POD_ORBSTACK_SETTINGS_SECTION_ID,
      title: getPodOrbstackSettingsTitle(),
      description: getPodOrbstackSettingsDescription(),
      icon: Container,
      searchEntries: getPodOrbstackSearchEntries(),
      group: 'remote'
    }
  ]
}
