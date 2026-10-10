// Fork-only (Pod): what the daemon needs from main for the direct lane's peer check.
import { getAppEnvironment } from '../../../shared/app-environment'
import { podPeerIdentityAddonPath } from '../../pod/ui-host/pod-peer-identity'

export function podLaneDaemonEnv(): NodeJS.ProcessEnv {
  if (process.platform !== 'darwin') {
    return {}
  }
  try {
    const app = getAppEnvironment()
    return {
      POD_PEER_IDENTITY_ADDON: podPeerIdentityAddonPath({
        resourcesPath: typeof process.resourcesPath === 'string' ? process.resourcesPath : null,
        appPath: app.getAppPath(),
        isPackaged: app.isPackaged()
      })
    }
  } catch {
    // No app environment (a bare test host): the lane then admits no one.
    return {}
  }
}
