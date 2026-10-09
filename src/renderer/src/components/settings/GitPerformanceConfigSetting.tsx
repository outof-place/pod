import { useState } from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  GIT_PERFORMANCE_CONFIG_KEYS,
  GIT_PERFORMANCE_CONFIG_VALUES
} from '../../../../shared/git-performance-config-plan'
import {
  normalizeGitTuningMode,
  type GitTuningMode
} from '../../../../shared/git-performance-config-types'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { SettingsRow, SettingsSegmentedControl } from './SettingsFormControls'
import { matchesSettingsSearch } from './settings-search'
import { GitPerformanceConfigRepoList } from './GitPerformanceConfigRepoList'
import {
  GIT_PERFORMANCE_CONFIG_KEYWORDS,
  GIT_PERFORMANCE_CONFIG_SECTION_ID,
  getGitPerformanceConfigDescription,
  getGitPerformanceConfigKeyDescription,
  getGitPerformanceConfigTitle
} from './git-performance-config-copy'

export function gitPerformanceConfigMatchesSearch(searchQuery: string): boolean {
  return matchesSettingsSearch(searchQuery, {
    title: getGitPerformanceConfigTitle(),
    description: getGitPerformanceConfigDescription(),
    keywords: GIT_PERFORMANCE_CONFIG_KEYWORDS
  })
}

export function GitPerformanceConfigSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}): React.JSX.Element {
  const title = getGitPerformanceConfigTitle()
  const description = getGitPerformanceConfigDescription()
  const mode = normalizeGitTuningMode(settings.gitTuning)
  const [refreshSignal, setRefreshSignal] = useState(0)

  const changeMode = async (nextMode: GitTuningMode): Promise<void> => {
    if (nextMode === mode) {
      return
    }
    // Why await before refreshing: main queues its revert when the setting lands, and the
    // rows' reads must arrive after it to show the reverted state.
    await updateSettings({ gitTuning: nextMode })
    setRefreshSignal((value) => value + 1)
  }

  return (
    <SearchableSetting
      id={GIT_PERFORMANCE_CONFIG_SECTION_ID}
      title={title}
      description={description}
      keywords={GIT_PERFORMANCE_CONFIG_KEYWORDS}
      className="max-w-none space-y-3"
    >
      <SettingsRow
        label={title}
        description={description}
        alignTop
        control={
          <SettingsSegmentedControl<GitTuningMode>
            value={mode}
            onChange={(nextMode) => void changeMode(nextMode)}
            ariaLabel={title}
            size="sm"
            options={[
              {
                value: 'off',
                label: translate('auto.components.settings.GitPerformanceConfig.off', 'Off')
              },
              {
                value: 'recommended',
                label: translate(
                  'auto.components.settings.GitPerformanceConfig.recommended',
                  'Recommended'
                )
              }
            ]}
          />
        }
      />
      <ul className="space-y-1">
        {GIT_PERFORMANCE_CONFIG_KEYS.map((key) => (
          <li key={key} className="text-xs text-muted-foreground">
            <code className="font-mono text-foreground">
              {key}={GIT_PERFORMANCE_CONFIG_VALUES[key]}
            </code>{' '}
            {getGitPerformanceConfigKeyDescription(key)}
          </li>
        ))}
      </ul>
      <GitPerformanceConfigRepoList mode={mode} refreshSignal={refreshSignal} />
    </SearchableSetting>
  )
}
