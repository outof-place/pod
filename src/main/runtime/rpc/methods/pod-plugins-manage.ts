// Fork-only (Pod): plugin install, remove and marketplace over RPC, the desktop's plugins:* IPC for
// PodNative's Plugins page. An install never activates anything: a new plugin waits for consent.
import { defineMethod } from '../core'
import { getPodPluginManage, type PodPluginManage } from '../../../pod/plugins/pod-plugin-manage'
import {
  PluginInstallParams,
  PluginKeyParams,
  PluginMarketplaceAddParams,
  PluginMarketplaceInstallParams,
  PluginMarketplaceInstalledParams,
  PluginMarketplacePluginParams,
  PluginMarketplaceRefreshParams,
  PluginMarketplaceSourceParams
} from '../../../../shared/rpc-contract/pod-plugins-manage-params'
import { assertLocalRpcCaller } from './pod-local-caller'

function manage(): PodPluginManage {
  const installed = getPodPluginManage()
  if (!installed) {
    throw new Error('runtime_unavailable')
  }
  return installed
}

function marketplace(): NonNullable<PodPluginManage['marketplace']> {
  const calls = manage().marketplace
  if (!calls) {
    throw new Error('Plugin marketplaces are not available on this runtime')
  }
  return calls
}

// Why host-admin and local: these write code into the plugins folder, as only this machine's
// own window could before.
export const POD_PLUGIN_MANAGE_METHODS = [
  defineMethod({
    name: 'plugins.install',
    permission: 'host-admin',
    params: PluginInstallParams,
    handler: (params, ctx) => {
      assertLocalRpcCaller(ctx, 'plugins.install')
      return manage().install(params)
    }
  }),
  defineMethod({
    name: 'plugins.remove',
    permission: 'host-admin',
    params: PluginKeyParams,
    handler: (params, ctx) => {
      assertLocalRpcCaller(ctx, 'plugins.remove')
      return manage().remove(params.pluginKey)
    }
  }),
  defineMethod({
    name: 'plugins.listMarketplaces',
    permission: 'host-admin',
    params: null,
    handler: (_params, ctx) => {
      assertLocalRpcCaller(ctx, 'plugins.listMarketplaces')
      return marketplace().listSources()
    }
  }),
  defineMethod({
    name: 'plugins.addMarketplace',
    permission: 'host-admin',
    params: PluginMarketplaceAddParams,
    handler: (params, ctx) => {
      assertLocalRpcCaller(ctx, 'plugins.addMarketplace')
      return marketplace().addSource(params)
    }
  }),
  defineMethod({
    name: 'plugins.removeMarketplace',
    permission: 'host-admin',
    params: PluginMarketplaceSourceParams,
    handler: (params, ctx) => {
      assertLocalRpcCaller(ctx, 'plugins.removeMarketplace')
      return marketplace().removeSource(params.sourceId)
    }
  }),
  defineMethod({
    name: 'plugins.refreshMarketplaces',
    permission: 'host-admin',
    params: PluginMarketplaceRefreshParams,
    handler: (params, ctx) => {
      assertLocalRpcCaller(ctx, 'plugins.refreshMarketplaces')
      return marketplace().refresh(params.sourceId)
    }
  }),
  defineMethod({
    name: 'plugins.listMarketplacePlugins',
    permission: 'host-admin',
    params: null,
    handler: (_params, ctx) => {
      assertLocalRpcCaller(ctx, 'plugins.listMarketplacePlugins')
      return marketplace().listPlugins()
    }
  }),
  defineMethod({
    name: 'plugins.previewMarketplacePlugin',
    permission: 'host-admin',
    params: PluginMarketplacePluginParams,
    handler: (params, ctx) => {
      assertLocalRpcCaller(ctx, 'plugins.previewMarketplacePlugin')
      return marketplace().preview(params.marketplaceSourceId, params.pluginKey)
    }
  }),
  defineMethod({
    name: 'plugins.installMarketplacePlugin',
    permission: 'host-admin',
    params: PluginMarketplaceInstallParams,
    handler: (params, ctx) => {
      assertLocalRpcCaller(ctx, 'plugins.installMarketplacePlugin')
      return marketplace().install(params)
    }
  }),
  defineMethod({
    name: 'plugins.previewMarketplaceUpdate',
    permission: 'host-admin',
    params: PluginMarketplaceInstalledParams,
    handler: (params, ctx) => {
      assertLocalRpcCaller(ctx, 'plugins.previewMarketplaceUpdate')
      return marketplace().previewUpdate(params.pluginKey)
    }
  }),
  defineMethod({
    name: 'plugins.rollbackMarketplacePlugin',
    permission: 'host-admin',
    params: PluginMarketplaceInstalledParams,
    handler: (params, ctx) => {
      assertLocalRpcCaller(ctx, 'plugins.rollbackMarketplacePlugin')
      return marketplace().rollback(params.pluginKey)
    }
  })
]
