import type React from 'react'
import { SettingsSection } from '@/components/settings/SettingsSection'
import type { SettingsRenderContext } from '@/components/settings/settings-render-context'
import { PodWorkspacePane } from './PodWorkspacePane'
import {
  POD_WORKSPACE_SETTINGS_SECTION_ID,
  getPodWorkspaceSettingsDescription,
  getPodWorkspaceSettingsTitle
} from './pod-workspace-settings-nav'

/** Fork-only (Pod): rendered only when the navigation model carries the section. */
export function renderPodWorkspaceSettingsSection(
  context: SettingsRenderContext
): React.JSX.Element | null {
  const { model, navigation, view } = context
  if (!navigation.navSections.some((section) => section.id === POD_WORKSPACE_SETTINGS_SECTION_ID)) {
    return null
  }
  return (
    <SettingsSection
      id={POD_WORKSPACE_SETTINGS_SECTION_ID}
      title={getPodWorkspaceSettingsTitle()}
      description={getPodWorkspaceSettingsDescription()}
      searchEntries={navigation.getSectionSearchEntries(POD_WORKSPACE_SETTINGS_SECTION_ID)}
    >
      {view.isSectionMounted(POD_WORKSPACE_SETTINGS_SECTION_ID) ? (
        <PodWorkspacePane settings={model.settings} updateSettings={model.updateSettings} />
      ) : null}
    </SettingsSection>
  )
}
