import { ipcMain } from 'electron'
import { z } from 'zod'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import {
  PLUGIN_PANEL_SURFACES,
  type PluginPanelActionOutcome,
  type PluginPanelEntry
} from '../../shared/plugins/plugin-panel-bridge'
import { installPlugin, removePlugin } from '../plugins/plugin-install-mutations'
import { applyPluginConsent, applyPluginEnablement } from '../plugins/plugin-enablement'
import type { PluginService } from '../plugins/plugin-service'
import { bindPluginPanelOwnerLifecycle } from '../plugins/plugin-panel-owner-lifecycle'
import { isQualifiedPluginKey } from '../../shared/plugins/plugin-manifest'
import { pluginConsentRequestSchema } from '../../shared/plugins/plugin-consent-request'
import { PluginInstallParams } from '../../shared/rpc-contract/pod-plugins-manage-params'
import {
  registerPluginMarketplaceHandlers,
  type PluginMarketplaceHandlerServices
} from './plugin-marketplaces'

export function parsePluginConsentArgs(args: unknown): z.infer<typeof pluginConsentRequestSchema> {
  return pluginConsentRequestSchema.parse(args)
}

const setEnabledArgsSchema = z.object({
  pluginKey: z.string().refine(isQualifiedPluginKey, 'invalid qualified plugin key'),
  enabled: z.boolean()
})

const readPanelEntryArgsSchema = z.object({
  pluginKey: z.string().min(1),
  panelId: z.string().min(1),
  surface: z.enum(PLUGIN_PANEL_SURFACES).optional()
})

const invokeCommandArgsSchema = z.object({
  pluginKey: z.string().min(1),
  commandId: z.string().min(1),
  args: z.unknown().optional()
})

export function parsePluginInstallArgs(args: unknown): PluginInstallParams {
  return PluginInstallParams.parse(args)
}

const removeArgsSchema = z.object({
  pluginKey: z.string().refine(isQualifiedPluginKey, 'invalid qualified plugin key')
})
const logsArgsSchema = z.object({ pluginKey: z.string().min(1) })

// Why re-exported: moved to ../plugins/plugin-client-list so the runtime RPC can reach
// it without ipcMain. Existing importers of this path keep working.
export { listPluginsForClients } from '../plugins/plugin-client-list'
import { listPluginsForClients } from '../plugins/plugin-client-list'

// Why re-exported: moved to ../plugins/plugin-install-mutations with install and remove (Pod's RPC).
export { canRemoveInstalledPlugin } from '../plugins/plugin-install-mutations'

function rendererPanelOwner(webContentsId: number): string {
  return `renderer:${webContentsId}`
}

export function registerPluginHandlers(
  store: Store,
  pluginService: PluginService,
  runtime: OrcaRuntimeService | null,
  marketplaceServices?: PluginMarketplaceHandlerServices
): void {
  // The runtime IS the delegate: the structural PluginRuntimeDelegate type
  // keeps the facade electron-free while main binds the real service.
  if (runtime) {
    pluginService.setRuntimeDelegate(runtime)
  }

  store.onSettingsChanged((updates) => {
    if ('pluginSystemEnabled' in updates || 'devPluginPaths' in updates) {
      // Main owns plugin lifecycle. Renderer follow-up refreshes are UX only;
      // a crashed or remote caller must not leave old workers authoritative.
      void pluginService.refresh().catch((error) => {
        console.warn('[plugins] failed to apply plugin settings change:', error)
      })
    }
  })

  // Why: startup discovery is fire-and-forget; every handler awaits it so an
  // early renderer fetch can't observe the empty pre-discovery list.
  ipcMain.handle('plugins:list', async () => listPluginsForClients(pluginService))
  ipcMain.handle('plugins:listLanguagePacks', async () => {
    await pluginService.whenReady()
    return pluginService.contentPacks.languagePacks.list()
  })
  ipcMain.handle('plugins:consent', async (event, args: unknown) => {
    await pluginService.whenReady()
    const parsed = parsePluginConsentArgs(args)
    await applyPluginConsent({
      store,
      pluginService,
      pluginKey: parsed.pluginKey,
      reviewedFingerprint: parsed.reviewedFingerprint,
      decision: parsed.decision,
      originWebContentsId: event.sender.id
    })
    return listPluginsForClients(pluginService)
  })

  ipcMain.handle('plugins:setEnabled', async (event, args: unknown) => {
    await pluginService.whenReady()
    const parsed = setEnabledArgsSchema.parse(args)
    await applyPluginEnablement({
      store,
      pluginService,
      pluginKey: parsed.pluginKey,
      enabled: parsed.enabled,
      originWebContentsId: event.sender.id
    })
    return listPluginsForClients(pluginService)
  })

  // Why: the renderer renders panel HTML via a sandboxed iframe srcdoc, so it
  // needs (CSP-wrapped) file contents — never a file:// path — across IPC.
  ipcMain.handle(
    'plugins:readPanelEntry',
    async (event, args: unknown): Promise<PluginPanelEntry | null> => {
      const ownerKey = rendererPanelOwner(event.sender.id)
      const ownerLease = bindPluginPanelOwnerLifecycle(event.sender, () =>
        pluginService.panels.revokeOwner(ownerKey)
      )
      await pluginService.whenReady()
      const parsed = readPanelEntryArgsSchema.parse(args)
      const entry = await pluginService.panels.open(
        ownerKey,
        parsed.pluginKey,
        parsed.panelId,
        parsed.surface
      )
      if (!ownerLease.isCurrent()) {
        pluginService.panels.revokeOwner(ownerKey)
        return null
      }
      return entry
    }
  )

  // Panel-originated actions relayed by the renderer's postMessage bridge
  // host. Capability enforcement happens in main, never in the renderer.
  ipcMain.handle(
    'plugins:panelAction',
    async (event, args: unknown): Promise<PluginPanelActionOutcome> => {
      await pluginService.whenReady()
      return pluginService.panels.execute(rendererPanelOwner(event.sender.id), args)
    }
  )

  // Live panel channel. Identity comes only from the session issued while the
  // renderer loaded the panel, never from caller-supplied plugin keys.
  ipcMain.handle('plugins:attachPanel', async (event, args: unknown): Promise<boolean> => {
    await pluginService.whenReady()
    const sender = event.sender
    return pluginService.panels.attach(rendererPanelOwner(sender.id), args, (delivery) => {
      if (!sender.isDestroyed()) {
        sender.send('plugins:panelMessage', delivery)
      }
    })
  })
  ipcMain.handle('plugins:detachPanel', async (event, args: unknown): Promise<void> => {
    pluginService.panels.detach(rendererPanelOwner(event.sender.id), args)
  })
  ipcMain.handle(
    'plugins:postPanelMessage',
    async (event, args: unknown): Promise<PluginPanelActionOutcome> => {
      await pluginService.whenReady()
      return pluginService.panels.receiveFromPanel(rendererPanelOwner(event.sender.id), args)
    }
  )

  // Why here, not at startup: a client rendering a status bar is the trigger
  // that starts status-bar workers, so headless hosts never fork them.
  ipcMain.handle('plugins:listStatusBarItems', async () => {
    await pluginService.whenReady()
    return pluginService.surfaces.statusBar.listForSurface(pluginService.getDiscovered())
  })

  ipcMain.handle('plugins:invokeCommand', async (_event, args: unknown) => {
    await pluginService.whenReady()
    const parsed = invokeCommandArgsSchema.parse(args)
    return pluginService.invokeCommand(parsed.pluginKey, parsed.commandId, parsed.args)
  })

  ipcMain.handle('plugins:install', async (_event, args: unknown) =>
    installPlugin(pluginService, parsePluginInstallArgs(args))
  )

  ipcMain.handle('plugins:remove', async (event, args: unknown) => {
    const parsed = removeArgsSchema.parse(args)
    return removePlugin({
      store,
      pluginService,
      pluginKey: parsed.pluginKey,
      originWebContentsId: event.sender.id
    })
  })

  ipcMain.handle('plugins:getLogs', async (_event, args: unknown) => {
    const parsed = logsArgsSchema.parse(args)
    return pluginService.getLogs(parsed.pluginKey)
  })

  // Re-discover after settings edits (feature flag, dev paths) — the
  // renderer calls this right after updating those settings.
  ipcMain.handle('plugins:refresh', async () => {
    await pluginService.refresh()
    return listPluginsForClients(pluginService)
  })
  if (marketplaceServices) {
    registerPluginMarketplaceHandlers(pluginService, marketplaceServices)
  }
}
