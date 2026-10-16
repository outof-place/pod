import type { PluginMarketplaceGitSource } from '../../shared/plugins/plugin-marketplace'
import type {
  PluginMarketplaceInstaller,
  PluginMarketplacePreviewIdentity
} from './plugin-marketplace-installer'
import type { PluginMarketplaceService } from './plugin-marketplace-service'
import type { PluginService } from './plugin-service'

export type PluginMarketplaceHandlerServices = {
  marketplace: PluginMarketplaceService
  installer: PluginMarketplaceInstaller
}

/**
 * The marketplace's calls, already validated: the desktop's plugins:* IPC and the runtime's RPC
 * (Pod) run these, out of `ipc/plugin-marketplaces.ts` so the RPC reaches them without `ipcMain`.
 */
export function pluginMarketplaceCalls(
  pluginService: PluginService,
  services: PluginMarketplaceHandlerServices
) {
  return {
    listSources: () => services.marketplace.listSources(),
    addSource: (source: PluginMarketplaceGitSource) => services.marketplace.addSource(source),
    removeSource: async (sourceId: string) => {
      await services.marketplace.removeSource(sourceId)
      return services.marketplace.listSources()
    },
    refresh: async (sourceId?: string) =>
      sourceId
        ? [await services.marketplace.refreshSource(sourceId)]
        : services.marketplace.refreshAll(),
    listPlugins: () => services.marketplace.listPlugins(),
    preview: (marketplaceSourceId: string, pluginKey: string) =>
      services.installer.preview(marketplaceSourceId, pluginKey),
    install: async (identity: PluginMarketplacePreviewIdentity) => {
      const result = await services.installer.install(identity)
      if (result.ok) {
        await pluginService.refresh()
      }
      return result
    },
    previewUpdate: (pluginKey: string) => services.installer.previewInstalledUpdate(pluginKey),
    rollback: async (pluginKey: string) => {
      await pluginService.deactivatePlugin(pluginKey)
      const result = await services.installer.rollback(pluginKey)
      if (result.ok) {
        await pluginService.refresh()
      }
      return result
    }
  }
}

export type PluginMarketplaceCalls = ReturnType<typeof pluginMarketplaceCalls>
