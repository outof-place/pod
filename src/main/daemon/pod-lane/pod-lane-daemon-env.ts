// Fork-only (Pod): what the daemon needs from main for the direct lane's peer check.
import { dirname, join } from 'node:path'
import { getAppEnvironment } from '../../../shared/app-environment'
import { podPeerIdentityAddonPath } from '../../pod/ui-host/pod-peer-identity'

/** `relocatedExecPath`: the daemon-host clone's `Contents/MacOS/<exe>`, whose bundle holds the addon. */
export function podLaneDaemonEnv(relocatedExecPath?: string): NodeJS.ProcessEnv {
  if (process.platform !== 'darwin') {
    return {}
  }
  try {
    const app = getAppEnvironment()
    // Why: the daemon loads the addon from this path, and a relocated daemon must not map anything
    // from the installed bundle (an update deletes it).
    const resourcesPath = relocatedExecPath
      ? join(dirname(dirname(relocatedExecPath)), 'Resources')
      : typeof process.resourcesPath === 'string'
        ? process.resourcesPath
        : null
    return {
      POD_PEER_IDENTITY_ADDON: podPeerIdentityAddonPath({
        resourcesPath,
        appPath: app.getAppPath(),
        isPackaged: app.isPackaged()
      })
    }
  } catch {
    // No app environment (a bare test host): the lane then admits no one.
    return {}
  }
}
