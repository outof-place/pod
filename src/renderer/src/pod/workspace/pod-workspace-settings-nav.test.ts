import { describe, expect, it } from 'vitest'
import { buildSettingsNavigationMetadata } from '@/hooks/useSettingsNavigationMetadata'
import { isReplaceableCloneDestination } from './use-pod-clone-destination'
import {
  buildPodWorkspaceSettingsSections,
  POD_WORKSPACE_SETTINGS_SECTION_ID
} from './pod-workspace-settings-nav'

describe('Pod workspace Settings section', () => {
  it('exists only while the workspace is enabled', () => {
    expect(buildPodWorkspaceSettingsSections({})).toEqual([])
    expect(buildPodWorkspaceSettingsSections({ podWorkspaceEnabled: true })).toMatchObject([
      { id: POD_WORKSPACE_SETTINGS_SECTION_ID, title: 'Workspace', group: 'setup' }
    ])
  })

  it('sits right after General in the Set Up group', () => {
    const ids = (podWorkspaceEnabled: boolean) =>
      buildSettingsNavigationMetadata({
        isMac: true,
        isWindows: false,
        isWebClient: false,
        podWorkspaceEnabled,
        repos: []
      }).map((section) => section.id)
    expect(ids(false)).not.toContain(POD_WORKSPACE_SETTINGS_SECTION_ID)
    const enabled = ids(true)
    expect(enabled[enabled.indexOf('general') + 1]).toBe(POD_WORKSPACE_SETTINGS_SECTION_ID)
  })
})

describe('isReplaceableCloneDestination', () => {
  const defaults = { podDefault: '/Users/me/pod/acme', orcaDefault: '/Users/me/orca' }

  it('replaces empty and default destinations only', () => {
    expect(isReplaceableCloneDestination('', defaults)).toBe(true)
    expect(isReplaceableCloneDestination('/Users/me/orca', defaults)).toBe(true)
    expect(isReplaceableCloneDestination(' /Users/me/pod/acme ', defaults)).toBe(true)
    expect(isReplaceableCloneDestination('/Volumes/Work', defaults)).toBe(false)
  })
})
