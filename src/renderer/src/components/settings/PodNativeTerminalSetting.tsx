// Fork-only (Pod): see pod-native-terminal-setting.ts.
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitchRow } from './SettingsFormControls'
import {
  isPodNativeTerminalSetting,
  POD_NATIVE_TERMINAL_SEARCH_ENTRY
} from './pod-native-terminal-setting'

type PodNativeTerminalSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function PodNativeTerminalSetting({
  settings,
  updateSettings
}: PodNativeTerminalSettingProps): React.JSX.Element | null {
  if (!isPodNativeTerminalSetting()) {
    return null
  }
  const { title, description, keywords } = POD_NATIVE_TERMINAL_SEARCH_ENTRY
  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={keywords}
      className="py-2"
      id="terminal-native-ghostty"
    >
      <SettingsSwitchRow
        label={title}
        description={description}
        checked={settings.experimentalNativeTerminal === true}
        onChange={() =>
          updateSettings({
            experimentalNativeTerminal: settings.experimentalNativeTerminal !== true
          })
        }
      />
    </SearchableSetting>
  )
}
