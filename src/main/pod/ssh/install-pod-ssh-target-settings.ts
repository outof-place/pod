// Fork-only (Pod): hands SSH settings' IPC operations to the runtime RPC (pod-ssh-target-settings.ts).
import { SSH_TERMINATE_RECONNECT_REQUIRED } from '../../../shared/constants'
import { errorMessage } from '../../../shared/error-message'
import { connectTarget } from '../../ipc/ssh-connect-flow'
import { disconnectRegisteredSshTarget } from '../../ipc/ssh-session-teardown'
import {
  addSshTargetFromSettings,
  assertSshTargetRemovable,
  importSshTargetsFromConfig,
  removeSshTargetFromSettings,
  updateSshTargetFromSettings
} from '../../ipc/ssh-target-crud-handlers'
import { terminateSshTargetSessions } from '../../ipc/ssh-terminate-sessions'
import { setPodSshTargetSettingsOps } from './pod-ssh-target-settings'

/** Called where the SSH IPC handlers register (registerSshHandlers), window or headless. */
export function installPodSshTargetSettings(): void {
  setPodSshTargetSettingsOps({
    add: addSshTargetFromSettings,
    update: updateSshTargetFromSettings,
    remove: removeSshTargetWithTerminals,
    importConfig: importSshTargetsFromConfig,
    disconnect: disconnectRegisteredSshTarget
  })
}

/**
 * The pane's Remove (removeSshTargetWithBestEffortCleanup): the host's remote terminals end first,
 * best effort, so an unreachable host can still be removed. Refused hosts end nothing.
 */
async function removeSshTargetWithTerminals(id: string): Promise<void> {
  assertSshTargetRemovable(id)
  try {
    await terminateSshTargetSessions(id)
  } catch (error) {
    if (errorMessage(error).includes(SSH_TERMINATE_RECONNECT_REQUIRED)) {
      try {
        await connectTarget(id)
        await terminateSshTargetSessions(id)
      } catch (reconnectError) {
        console.warn(
          '[ssh] Skipping remote session cleanup during target removal:',
          errorMessage(reconnectError)
        )
      }
    } else {
      console.warn(
        '[ssh] Skipping remote session cleanup during target removal:',
        errorMessage(error)
      )
    }
  }
  await removeSshTargetFromSettings(id)
}
