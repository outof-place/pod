import type React from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { PodWorkspaceRootSetting } from './PodWorkspaceRootSetting'

type PodWorkspacePaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function PodWorkspacePane({
  settings,
  updateSettings
}: PodWorkspacePaneProps): React.JSX.Element {
  return (
    <div className="space-y-8">
      <PodWorkspaceRootSetting settings={settings} updateSettings={updateSettings} />
    </div>
  )
}
