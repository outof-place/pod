import type React from 'react'
import { SettingsSection } from '@/components/settings/SettingsSection'
import type { SettingsRenderContext } from '@/components/settings/settings-render-context'
import { PodOrbstackPane } from './PodOrbstackPane'
import {
  POD_ORBSTACK_SETTINGS_SECTION_ID,
  getPodOrbstackSettingsDescription,
  getPodOrbstackSettingsTitle
} from './pod-orbstack-settings-nav'

/** Fork-only (Pod): rendered only when the navigation model carries the section. */
export function renderPodOrbstackSettingsSection(
  context: SettingsRenderContext
): React.JSX.Element | null {
  const { navigation, view } = context
  if (!navigation.navSections.some((section) => section.id === POD_ORBSTACK_SETTINGS_SECTION_ID)) {
    return null
  }
  return (
    <SettingsSection
      id={POD_ORBSTACK_SETTINGS_SECTION_ID}
      title={getPodOrbstackSettingsTitle()}
      description={getPodOrbstackSettingsDescription()}
      searchEntries={navigation.getSectionSearchEntries(POD_ORBSTACK_SETTINGS_SECTION_ID)}
    >
      {view.isSectionMounted(POD_ORBSTACK_SETTINGS_SECTION_ID) ? <PodOrbstackPane /> : null}
    </SettingsSection>
  )
}
