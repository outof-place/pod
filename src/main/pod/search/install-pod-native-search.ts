import { getAppEnvironment } from '../../../shared/app-environment'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import {
  notifyExternalSearchWorktreeLifecycle,
  setExternalWorkspaceSearchProvider
} from '../../search/external-workspace-search-provider'
import { OgdClient, resolveOgdSocketPath } from './ogd-client'
import { isPodNativeSearchEnabled } from './pod-native-search-flag'
import { readOgdIndexStatus, type PodSearchIndexStatus } from './pod-search-index-status'
import { createPodSearchProvider } from './pod-search-provider'

let installed = false
let enabledClient: () => OgdClient | null = () => null

/**
 * Routes local quick open and file search through ogd when Pod search is enabled. Idempotent;
 * Electron-free, so the desktop, `orca serve` and orcad share it.
 */
export function installPodNativeSearch(
  store: { getSettings(): GlobalSettings },
  runtime: {
    onWorktreeLifecycle?: (
      listener: (event: { kind: 'created' | 'removed'; path: string }) => void
    ) => unknown
  }
): void {
  if (installed) {
    return
  }
  installed = true
  let client: OgdClient | null = null
  let clientSocketPath: string | null = null
  const isEnabled = () => isPodNativeSearchEnabled(store.getSettings())
  const currentClient = () => {
    const socketPath = resolveOgdSocketPath()
    if (socketPath !== clientSocketPath) {
      client?.close()
      client = socketPath
        ? new OgdClient({ socketPath, client: `orca/${getAppEnvironment().getVersion()}` })
        : null
      clientSocketPath = socketPath
    }
    return client
  }
  enabledClient = () => (isEnabled() ? currentClient() : null)
  setExternalWorkspaceSearchProvider(createPodSearchProvider({ isEnabled, client: currentClient }))
  // Runtime-managed creates and removals (CLI, agents) do not pass through the IPC handlers.
  runtime.onWorktreeLifecycle?.(notifyExternalSearchWorktreeLifecycle)
}

/** ogd's status for `root` on the shared client; null while Pod search is off or not installed. */
export async function getPodSearchIndexStatus(root: string): Promise<PodSearchIndexStatus | null> {
  const client = enabledClient()
  return client ? readOgdIndexStatus(client, root) : null
}
