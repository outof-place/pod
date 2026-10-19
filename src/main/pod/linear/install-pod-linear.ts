// Fork-only (Pod): podLinear over the settings store and agent access over its sealed file, for the
// RPC admission check and linear.status.
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { setPodLinearAgentAccessSetting } from './pod-linear-access'
import { writeSealedLinearAgentAccess } from './pod-linear-agent-access-store'
import { currentLinearConnectionIds, isLinearAgentAccessGranted } from './pod-linear-agent-scope'
import { setPodLinearEnabledSetting } from './pod-linear-availability'

export function installPodLinear(store: {
  getSettings(): Pick<GlobalSettings, 'podLinear'>
  updateSettings(updates: Pick<GlobalSettings, 'podLinear'>): unknown
}): void {
  setPodLinearEnabledSetting({
    // Absent means off: turning Linear on for users is its own decision.
    read: () => store.getSettings().podLinear === true,
    write: (enabled) => {
      store.updateSettings({ podLinear: enabled })
    }
  })
  // Not a settings key: an agent can edit the settings file (pod-linear-agent-access-store.ts).
  setPodLinearAgentAccessSetting({
    read: isLinearAgentAccessGranted,
    // A grant names the workspaces connected now; a later Connect needs a new one.
    write: (enabled) =>
      writeSealedLinearAgentAccess(enabled, enabled ? currentLinearConnectionIds() : [])
  })
}
