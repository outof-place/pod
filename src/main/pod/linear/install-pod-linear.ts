// Fork-only (Pod): podLinear and podLinearAgentAccess over the settings store, for the RPC
// admission check and linear.status.
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { setPodLinearAgentAccessSetting } from './pod-linear-access'
import { setPodLinearEnabledSetting } from './pod-linear-availability'

export function installPodLinear(store: {
  getSettings(): Pick<GlobalSettings, 'podLinear' | 'podLinearAgentAccess'>
  updateSettings(updates: Pick<GlobalSettings, 'podLinear' | 'podLinearAgentAccess'>): unknown
}): void {
  setPodLinearEnabledSetting({
    // Absent means off: turning Linear on for users is its own decision.
    read: () => store.getSettings().podLinear === true,
    write: (enabled) => {
      store.updateSettings({ podLinear: enabled })
    }
  })
  setPodLinearAgentAccessSetting({
    // Absent means off: agents reach Linear only after the user turns it on.
    read: () => store.getSettings().podLinearAgentAccess === true,
    write: (enabled) => {
      store.updateSettings({ podLinearAgentAccess: enabled })
    }
  })
}
