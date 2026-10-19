// Fork-only (Pod): in a Pod build, Settings search and ⌘J find no Linear under Integrations; the
// classic Linear card is out and PodNative is Linear's only UI.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { podFeatureFlags } from '../../../shared/product/features'

async function search(query: string): Promise<{ settings: string[]; cmdJ: string[] }> {
  const { buildSettingsNavigationMetadata } = await import('@/hooks/useSettingsNavigationMetadata')
  const { getSettingsSectionSearchEntries, matchesSettingsSearch } =
    await import('@/components/settings/settings-search')
  const { buildCmdJSettingsResults, rankCmdJMiddleResults } =
    await import('@/components/cmd-j/palette-results')
  const { isPodSettingsSectionEnabled } = await import('../../../shared/product/features')
  // As useSettingsNavigationMetadata builds them, with a Linear key stored.
  const sections = buildSettingsNavigationMetadata({
    isMac: true,
    isWindows: false,
    isWebClient: false,
    isLinearConnected: true,
    repos: []
  }).filter((section) => isPodSettingsSectionEnabled(section.id))
  return {
    settings: sections
      .filter((section) => matchesSettingsSearch(query, getSettingsSectionSearchEntries(section)))
      .map((section) => section.id),
    cmdJ: rankCmdJMiddleResults({
      query,
      settingsResults: buildCmdJSettingsResults(sections),
      actionResults: []
    }).map((result) => result.id)
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('"linear" in Settings search and ⌘J', () => {
  it('finds Integrations with the classic Linear card', async () => {
    const found = await search('linear')

    expect(found.settings).toContain('integrations')
    expect(found.cmdJ).toContain('settings:integrations')
  })

  it('finds no Integrations in a Pod build, while "gitlab" still does', async () => {
    vi.stubGlobal('__POD_FEATURES__', podFeatureFlags('pod'))
    vi.resetModules()

    const linear = await search('linear')
    // Appearance and Shortcuts still list the Tasks button's "linear" keyword; Tasks isn't Linear's UI.
    expect(linear.settings).not.toContain('integrations')
    expect(linear.cmdJ).toEqual([])
    const gitlab = await search('gitlab')
    expect(gitlab.settings).toContain('integrations')
    expect(gitlab.cmdJ).toContain('settings:integrations')
  })
})
