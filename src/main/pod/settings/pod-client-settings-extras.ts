// Fork-only (Pod): what settings.get adds for a native Pod client, the settings it follows but
// doesn't edit (pod-settings-read-only.ts). Nothing without Pod's settings service, so upstream
// Orca's answer stays as it is.
import { projectPodSettingsReadOnly } from '../../../shared/pod-settings-read-only'
import { getPodSettingsService } from './pod-settings-service'

export type PodClientSettingsExtras = {
  openLinksInApp?: boolean
  openLinksInAppModifierInverts?: boolean
  sourceControlAi?: { enabled?: boolean }
}

/** `sourceControlAi` is the projection settings.get already sends, with `enabled` added. */
export function podClientSettingsExtras<T extends object>(
  settings: Parameters<typeof projectPodSettingsReadOnly>[0],
  sourceControlAi: T
): PodClientSettingsExtras & { sourceControlAi?: T & { enabled: boolean } } {
  if (!getPodSettingsService()) {
    return {}
  }
  const readOnly = projectPodSettingsReadOnly(settings)
  return {
    openLinksInApp: readOnly.openLinksInApp,
    openLinksInAppModifierInverts: readOnly.openLinksInAppModifierInverts,
    sourceControlAi: { ...sourceControlAi, enabled: readOnly.sourceControlAi.enabled }
  }
}
