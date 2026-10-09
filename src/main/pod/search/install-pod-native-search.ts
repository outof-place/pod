import { app } from 'electron'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import {
  notifyExternalSearchWorktreeLifecycle,
  setExternalWorkspaceSearchProvider
} from '../../search/external-workspace-search-provider'
import { OgdClient, resolveOgdSocketPath } from './ogd-client'
import { isPodNativeSearchEnabled } from './pod-native-search-flag'
import { createPodSearchProvider } from './pod-search-provider'

let installed = false

/** Routes local quick open and file search through ogd when Pod search is enabled. Idempotent. */
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
  setExternalWorkspaceSearchProvider(
    createPodSearchProvider({
      isEnabled: () => isPodNativeSearchEnabled(store.getSettings()),
      client: () => {
        const socketPath = resolveOgdSocketPath()
        if (socketPath !== clientSocketPath) {
          client?.close()
          client = socketPath
            ? new OgdClient({ socketPath, client: `orca/${app.getVersion()}` })
            : null
          clientSocketPath = socketPath
        }
        return client
      }
    })
  )
  // Runtime-managed creates and removals (CLI, agents) do not pass through the IPC handlers.
  runtime.onWorktreeLifecycle?.(notifyExternalSearchWorktreeLifecycle)
}
