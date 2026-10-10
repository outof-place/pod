import { userInfo } from 'node:os'
import { join } from 'node:path'
import { app, dialog } from 'electron'
import { runProcess } from '../../../shared/child-process/run-process'
import { getProductIdentity } from '../../product-identity/product-identity'
import { setMacTrayYield } from '../../tray/system-tray'
import { syncMacMenuBarIcon } from '../../startup/main-window-actions'
import { mainProcessState as state } from '../../startup/main-process-state'
import { isBackgroundLaunch } from '../../window/foreground-activation-policy'
import { getPodDistroConfig } from '../pod-distro-config'
import { ACC_ROOTD_CONFIRM_DIALOG } from './acc-rootd'
import { startPodAccSupervisor } from './acc-supervisor'

let started = false

/** getpwuid's home for this uid: unlike app.getPath('home'), a HOME override does not move it. */
function accountHome(): string | null {
  try {
    return userInfo().homedir || null
  } catch {
    return null
  }
}

/** Asks before pod-rootd is registered, in front: the request came from Pod Menu, another app. */
async function confirmRootd(): Promise<boolean> {
  // an automated run never shows a window, and has no user to answer
  if (isBackgroundLaunch()) {
    return false
  }
  app.focus({ steal: true })
  const { response } = await dialog.showMessageBox(ACC_ROOTD_CONFIRM_DIALOG)
  return response === 0
}

/** Electron wiring for the supervisor; a no-op in builds whose identity has no claude-acc section. */
export function startPodAccFromStartup(): void {
  const config = getPodDistroConfig().claudeAcc
  if (started || !config || process.platform !== 'darwin' || state.isServeMode) {
    return
  }
  started = true
  const account = accountHome()
  const profile = getProductIdentity()?.userDataName
  const supervisor = startPodAccSupervisor({
    config,
    resourcesPath: process.resourcesPath,
    execPath: process.execPath,
    home: app.getPath('home'),
    accountHome: account,
    userDataPath: app.getPath('userData'),
    // the profile applyProductIdentityPreReady pins, anchored at the account home instead of $HOME
    defaultUserDataPath:
      account && profile ? join(account, 'Library', 'Application Support', profile) : null,
    platform: process.platform,
    env: process.env,
    run: (spec) => runProcess(spec, 'tail'),
    loginItems: app,
    appId: getProductIdentity()?.appId ?? null,
    setTrayYield: (helperRunning) => setMacTrayYield(helperRunning),
    syncTray: () => {
      if (state.store) {
        syncMacMenuBarIcon(state.store.getSettings().showMenuBarIcon !== false)
      }
    },
    log: (message) => console.log(`[pod] ${message}`),
    confirmRootd
  })
  app.once('will-quit', () => supervisor.stop())
}
