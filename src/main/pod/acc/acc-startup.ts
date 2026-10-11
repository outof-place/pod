import { join } from 'node:path'
import { app } from 'electron'
import { runProcess } from '@orca/process-host'
import { getProductIdentity } from '../../product-identity/product-identity'
import { setMacTrayYield } from '../../tray/system-tray'
import { syncMacMenuBarIcon } from '../../startup/main-window-actions'
import { mainProcessState as state } from '../../startup/main-process-state'
import { getPodDistroConfig } from '../pod-distro-config'
import { isPodHeadlessUiHost } from '../ui-host/pod-ui-host-launch'
import { accountHome } from '../instance/pod-instance'
import { startPodAccSupervisor } from './acc-supervisor'

let started = false

/** Electron wiring for the supervisor; a no-op in builds whose identity has no claude-acc section. */
export function startPodAccFromStartup(): void {
  const config = getPodDistroConfig().claudeAcc
  // The headless one-app runtime is Pod's app runtime, not a `serve` host: it runs claude-acc.
  if (
    started ||
    !config ||
    process.platform !== 'darwin' ||
    (state.isServeMode && !isPodHeadlessUiHost())
  ) {
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
    setTrayYield: (helperRunning) => setMacTrayYield(helperRunning),
    syncTray: () => {
      if (state.store) {
        syncMacMenuBarIcon(state.store.getSettings().showMenuBarIcon !== false)
      }
    },
    log: (message) => console.log(`[pod] ${message}`)
  })
  app.once('will-quit', () => supervisor.stop())
}
