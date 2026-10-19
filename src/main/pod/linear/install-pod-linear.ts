// Fork-only (Pod): podLinearAgentAccess over the settings store, for the RPC admission check.
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { setPodLinearAgentAccessSetting } from './pod-linear-access'

export function installPodLinear(store: {
  getSettings(): Pick<GlobalSettings, 'podLinearAgentAccess'>
  updateSettings(updates: Pick<GlobalSettings, 'podLinearAgentAccess'>): unknown
}): void {
  setPodLinearAgentAccessSetting({
    // Absent means off: agents reach Linear only after the user turns it on.
    read: () => store.getSettings().podLinearAgentAccess === true,
    write: (enabled) => {
      store.updateSettings({ podLinearAgentAccess: enabled })
    }
  })
}
