// Fork-only (Pod): hands projectGroups:scanNested/importNested's SSH branch to the runtime RPC
// (pod-ssh-nested-repos.ts): the desktop's own scan and import, on a connected host only.
import type { Store } from '../../persistence'
import { importNestedReposForStore } from '../../ipc/repos/nested-repo-import-handler'
import { scanNestedReposForIpc } from '../../ipc/repos/nested-repo-scan-ipc'
import { getSshConnectionManager } from '../../ssh/ssh-target-registry'
import { setPodSshNestedRepos } from './pod-ssh-nested-repos'

// Why: the IPC's own check is only that providers exist; a host mid-reconnect must not be read.
function assertConnected(connectionId: string): void {
  if (getSshConnectionManager()?.getState(connectionId)?.status !== 'connected') {
    throw new Error('ssh_connection_unavailable')
  }
}

/** Called where the SSH IPC handlers register (registerSshHandlers), window or headless. */
export function installPodSshNestedRepos(store: Store): void {
  setPodSshNestedRepos({
    scan: async (connectionId, path) => {
      assertConnected(connectionId)
      return scanNestedReposForIpc({ path, connectionId, options: { timeoutMs: 15_000 } })
    },
    import: async (args) => {
      assertConnected(args.connectionId)
      return importNestedReposForStore(store, args)
    }
  })
}
