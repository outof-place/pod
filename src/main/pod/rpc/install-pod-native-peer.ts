// Fork-only (Pod): names the peer-identity addon for the runtime's local stream connections.
import { app } from 'electron'
import { loadPodPeerVerifier, podPeerIdentityAddonPath } from '../ui-host/pod-peer-identity'
import { setPodNativePeerVerifierLoader } from './pod-native-peer'

/** The addon loads only when a call first needs a connection checked. */
export function installPodNativePeerCheck(): void {
  if (process.platform !== 'darwin') {
    return
  }
  setPodNativePeerVerifierLoader(() =>
    loadPodPeerVerifier(
      podPeerIdentityAddonPath({
        resourcesPath: typeof process.resourcesPath === 'string' ? process.resourcesPath : null,
        appPath: app.getAppPath(),
        isPackaged: app.isPackaged
      })
    )
  )
}
