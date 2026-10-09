import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { Label } from '../ui/label'
import { getExperimentalSearchEntry } from './experimental-search'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitch } from './SettingsFormControls'

type EditorGpuAccelerationExperimentalSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function EditorGpuAccelerationExperimentalSetting({
  settings,
  updateSettings
}: EditorGpuAccelerationExperimentalSettingProps): React.JSX.Element {
  const entry = getExperimentalSearchEntry().editorGpuAcceleration
  const enabled = settings.experimentalEditorGpuAcceleration === true

  return (
    <SearchableSetting
      title={entry.title}
      description={entry.description}
      keywords={entry.keywords}
      className="space-y-3 py-2"
      id="experimental-editor-gpu-acceleration"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 shrink space-y-0.5">
          <Label>{entry.title}</Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.ExperimentalPane.editorGpuAcceleration.copy',
              'Draws file-editor text with the GPU (WebGPU), which lowers CPU use while scrolling large files. Lines the GPU renderer cannot draw fall back to the regular renderer. Applies to files opened after you change it.'
            )}
          </p>
        </div>
        <SettingsSwitch
          checked={enabled}
          ariaLabel={translate(
            'auto.components.settings.ExperimentalPane.editorGpuAcceleration.toggleLabel',
            'Toggle GPU editor rendering'
          )}
          onChange={() => updateSettings({ experimentalEditorGpuAcceleration: !enabled })}
        />
      </div>
    </SearchableSetting>
  )
}
