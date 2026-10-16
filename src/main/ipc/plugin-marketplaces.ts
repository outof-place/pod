import { ipcMain } from 'electron'
import { pluginMarketplaceGitSourceSchema } from '../../shared/plugins/plugin-marketplace'
import {
  PluginMarketplaceInstallParams,
  PluginMarketplaceInstalledParams,
  PluginMarketplacePluginParams,
  PluginMarketplaceRefreshParams,
  PluginMarketplaceSourceParams
} from '../../shared/rpc-contract/pod-plugins-manage-params'
import {
  pluginMarketplaceCalls,
  type PluginMarketplaceHandlerServices
} from '../plugins/plugin-marketplace-calls'
import type { PluginService } from '../plugins/plugin-service'

export type { PluginMarketplaceHandlerServices } from '../plugins/plugin-marketplace-calls'

export function registerPluginMarketplaceHandlers(
  pluginService: PluginService,
  services: PluginMarketplaceHandlerServices
): void {
  const calls = pluginMarketplaceCalls(pluginService, services)
  ipcMain.handle('plugins:listMarketplaces', () => calls.listSources())
  ipcMain.handle('plugins:addMarketplace', async (_event, args: unknown) =>
    calls.addSource(pluginMarketplaceGitSourceSchema.parse(args))
  )
  ipcMain.handle('plugins:removeMarketplace', async (_event, args: unknown) =>
    calls.removeSource(PluginMarketplaceSourceParams.parse(args).sourceId)
  )
  ipcMain.handle('plugins:refreshMarketplaces', async (_event, args: unknown) =>
    calls.refresh(PluginMarketplaceRefreshParams.parse(args ?? {}).sourceId)
  )
  ipcMain.handle('plugins:listMarketplacePlugins', () => calls.listPlugins())
  ipcMain.handle('plugins:previewMarketplacePlugin', async (_event, args: unknown) => {
    const parsed = PluginMarketplacePluginParams.parse(args)
    return calls.preview(parsed.marketplaceSourceId, parsed.pluginKey)
  })
  ipcMain.handle('plugins:installMarketplacePlugin', async (_event, args: unknown) =>
    calls.install(PluginMarketplaceInstallParams.parse(args))
  )
  ipcMain.handle('plugins:previewMarketplaceUpdate', async (_event, args: unknown) =>
    calls.previewUpdate(PluginMarketplaceInstalledParams.parse(args).pluginKey)
  )
  ipcMain.handle('plugins:rollbackMarketplacePlugin', async (_event, args: unknown) =>
    calls.rollback(PluginMarketplaceInstalledParams.parse(args).pluginKey)
  )
}
