// Fork-only (Pod): plugin install, remove and marketplace for runtime RPC (PodNative's Plugins page),
// through the desktop IPC's own functions. The plugin service lives in main's composition root, so
// main-process-plugins.ts installs it here.
import type { PluginInstallResult } from '../../plugins/plugin-install-staging'
import type { PluginListEntry } from '../../plugins/plugin-list-projection'
import type { PluginMarketplaceCalls } from '../../plugins/plugin-marketplace-calls'
import type { PluginInstallParams } from '../../../shared/rpc-contract/pod-plugins-manage-params'

export type PodPluginManage = {
  install: (source: PluginInstallParams) => Promise<PluginInstallResult>
  remove: (pluginKey: string) => Promise<PluginListEntry[]>
  /** Null on a runtime built without the marketplace. */
  marketplace: PluginMarketplaceCalls | null
}

let installed: PodPluginManage | null = null

export function setPodPluginManage(manage: PodPluginManage | null): void {
  installed = manage
}

/** Null until the plugin service starts, and where it never does (orcad). */
export function getPodPluginManage(): PodPluginManage | null {
  return installed
}
