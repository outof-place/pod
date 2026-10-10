import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, dialog } from 'electron'
import { relaunchApp } from '../app-relaunch'
import { shutdownDaemon } from '../daemon/daemon-provider-state'
import { quitProcess } from '../startup/process-quit-request'
import { legacyImportRequestPath, writeLegacyImportRequest } from './legacy-import-request'
import { liveSingletonOwner } from './legacy-profile-migration'
import type { ProductIdentity } from './product-identity'

/** "Import from Orca…": confirms, records the request, stops terminals and restarts into it. */
export async function importFromLegacyApp(identity: ProductIdentity): Promise<void> {
  const legacy = identity.legacyProfile
  if (!legacy) {
    return
  }
  const appData = app.getPath('appData')
  const legacyUserData = join(appData, legacy.userDataName)
  if (!existsSync(legacyUserData)) {
    await dialog.showMessageBox({
      type: 'info',
      message: 'No Orca profile to import',
      detail: `${identity.displayName} looked for it in ${legacyUserData}.`
    })
    return
  }
  const legacyPid = liveSingletonOwner(legacyUserData)
  if (legacyPid !== null) {
    await dialog.showMessageBox({
      type: 'warning',
      message: 'Quit Orca first',
      detail: `Orca is running (pid ${legacyPid}). Its databases can only be copied while it is closed.`
    })
    return
  }
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    message: 'Import your Orca profile?',
    detail: [
      `${identity.displayName} replaces its workspaces, settings and saved sign-ins with Orca's. Orca's own copy is not changed.`,
      `${identity.displayName}'s current profile is kept next to it as "${identity.userDataName} before Orca import".`,
      `Terminals open in ${identity.displayName} close, and ${identity.displayName} restarts to import.`
    ].join('\n\n'),
    buttons: ['Import and Restart', 'Cancel'],
    defaultId: 1,
    cancelId: 1
  })
  if (response !== 0) {
    return
  }
  writeLegacyImportRequest(legacyImportRequestPath(appData, identity.userDataName))
  // Why stop the daemon: the relaunch sets this profile aside, and a daemon left running would
  // keep its terminals alive with nothing able to reach them.
  await shutdownDaemon()
  relaunchApp('profile-transfer')
  quitProcess()
}
