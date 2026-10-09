// Fork-only (Pod): the Settings sidebar entry for the workspace root, without pane UI imports.
import { FolderTree } from 'lucide-react'
import { searchKeywords } from '@/components/settings/settings-search-keywords'
import type { SettingsSearchEntry } from '@/components/settings/settings-search'
import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import type { SettingsNavSection } from '@/lib/settings-navigation-types'

export const POD_WORKSPACE_SETTINGS_SECTION_ID = 'pod-workspace'

export function getPodWorkspaceSettingsTitle(): string {
  return translate('podWorkspace.section.title', 'Workspace')
}

export function getPodWorkspaceSettingsDescription(): string {
  return translate(
    'podWorkspace.section.description',
    'Where repositories live, and how Spotlight, Time Machine and the volume treat that folder.'
  )
}

export const getPodWorkspaceSearchEntries = createLocalizedCatalog((): SettingsSearchEntry[] => [
  {
    title: getPodWorkspaceSettingsTitle(),
    description: getPodWorkspaceSettingsDescription(),
    keywords: searchKeywords([
      { key: 'podWorkspace.search.root', fallback: 'workspace root' },
      { key: 'podWorkspace.search.clone', fallback: 'clone location' },
      { key: 'podWorkspace.search.spotlight', fallback: 'Spotlight', englishOnly: true },
      { key: 'podWorkspace.search.timeMachine', fallback: 'Time Machine', englishOnly: true },
      { key: 'podWorkspace.search.backup', fallback: 'backup' },
      { key: 'podWorkspace.search.volume', fallback: 'volume' },
      { key: 'podWorkspace.search.pnpm', fallback: 'pnpm store', englishOnly: true },
      { key: 'podWorkspace.search.health', fallback: 'health' },
      { key: 'podWorkspace.search.index', fallback: 'search index' }
    ])
  }
])

export function buildPodWorkspaceSettingsSections(options: {
  podWorkspaceEnabled?: boolean
}): SettingsNavSection[] {
  if (options.podWorkspaceEnabled !== true) {
    return []
  }
  return [
    {
      id: POD_WORKSPACE_SETTINGS_SECTION_ID,
      title: getPodWorkspaceSettingsTitle(),
      description: getPodWorkspaceSettingsDescription(),
      icon: FolderTree,
      searchEntries: getPodWorkspaceSearchEntries(),
      group: 'setup'
    }
  ]
}
