import type { Store } from '../persistence'
import type { PluginService } from './plugin-service'
import { getPluginsDataDir, getUserPluginsDir } from './plugin-discovery'
import {
  installPluginFromGit,
  installPluginFromLocalPath,
  readPluginLockfile,
  removeInstalledPlugin
} from './plugin-install'
import type { PluginInstallResult } from './plugin-install-staging'
import { listPluginsForClients } from './plugin-client-list'
import type { PluginListEntry } from './plugin-list-projection'
import { normalizePluginIdList } from '../../shared/plugins/plugin-consent-state'
import type { PluginLockfile } from '../../shared/plugins/plugin-install-lockfile'
import type { PluginInstallParams } from '../../shared/rpc-contract/pod-plugins-manage-params'

/**
 * Install and remove for the desktop's plugins:* IPC and the runtime's plugins.* RPC (Pod), out of
 * `ipc/plugins.ts` so the RPC reaches them without `ipcMain`.
 */

export function canRemoveInstalledPlugin(
  pluginService: PluginService,
  pluginKey: string,
  lock?: PluginLockfile
): boolean {
  return (
    lock?.plugins[pluginKey]?.source.kind !== 'bundled' &&
    pluginService.getDiscovered().some((plugin) => plugin.pluginKey === pluginKey && !plugin.isDev)
  )
}

export async function installPlugin(
  pluginService: PluginService,
  source: PluginInstallParams
): Promise<PluginInstallResult> {
  await pluginService.whenReady()
  const pluginsDir = getUserPluginsDir(pluginService.options.userDataPath)
  const hostVersion = pluginService.options.hostVersion
  const blockedPluginReason = (pluginKey: string): string | null =>
    pluginService.options.getPluginKillListEntry?.(pluginKey)?.reason ?? null
  const result =
    source.kind === 'local-path'
      ? await installPluginFromLocalPath({
          pluginsDir,
          sourcePath: source.path,
          hostVersion,
          blockedPluginReason
        })
      : await installPluginFromGit({
          pluginsDir,
          url: source.url,
          ref: source.ref,
          hostVersion,
          blockedPluginReason
        })
  if (result.ok) {
    await pluginService.refresh()
  }
  return result
}

export async function removePlugin(input: {
  store: Store
  pluginService: PluginService
  pluginKey: string
  originWebContentsId?: number
}): Promise<PluginListEntry[]> {
  const { store, pluginService, pluginKey } = input
  await pluginService.whenReady()
  const pluginsDir = getUserPluginsDir(pluginService.options.userDataPath)
  const lock = await readPluginLockfile(pluginsDir)
  if (!canRemoveInstalledPlugin(pluginService, pluginKey, lock)) {
    throw new Error(`cannot remove protected or non-installed plugin ${pluginKey}`)
  }
  await pluginService.removePlugin(pluginKey, () =>
    removeInstalledPlugin({
      pluginsDir,
      pluginsDataDir: getPluginsDataDir(pluginService.options.userDataPath),
      pluginKey
    })
  )
  // Drop the stale consent so a later reinstall re-prompts from scratch.
  const settings = store.getSettings()
  const consents = { ...settings.pluginConsents }
  delete consents[pluginKey]
  const disabledPlugins = normalizePluginIdList(settings.disabledPlugins).filter(
    (key) => key !== pluginKey
  )
  store.updateSettings(
    { pluginConsents: consents, disabledPlugins },
    { notifyListeners: true, originWebContentsId: input.originWebContentsId }
  )
  await pluginService.refresh()
  return listPluginsForClients(pluginService)
}
