// Fork-only (Pod): hands ssh:browseDir's listing to the runtime RPC (pod-ssh-remote-browse.ts).
import { browseSshDirectory } from '../../ipc/ssh-browse'
import { getSshConnectionManager } from '../../ssh/ssh-target-registry'
import { setPodSshRemoteBrowse } from './pod-ssh-remote-browse'

/** Called where the SSH IPC handlers register (registerSshHandlers), window or headless. */
export function installPodSshRemoteBrowse(): void {
  setPodSshRemoteBrowse((targetId, dirPath) =>
    browseSshDirectory(getSshConnectionManager(), { targetId, dirPath })
  )
}
