import { app } from 'electron'
import { runProcess } from '@orca/process-host'
import { setMacTrayYield } from '../../tray/system-tray'
import { syncMacMenuBarIcon } from '../../startup/main-window-actions'
import { mainProcessState as state } from '../../startup/main-process-state'
import { getPodDistroConfig } from '../pod-distro-config'
import { startPodAccSupervisor } from './acc-supervisor'

let started = false

/** Electron wiring for the supervisor; a no-op in builds whose identity has no claude-acc section. */
export function startPodAccFromStartup(): void {
  const config = getPodDistroConfig().claudeAcc
  if (started || !config || process.platform !== 'darwin' || state.isServeMode) {
    return
  }
  started = true
  const supervisor = startPodAccSupervisor({
    config,
    resourcesPath: process.resourcesPath,
    execPath: process.execPath,
    home: app.getPath('home'),
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
