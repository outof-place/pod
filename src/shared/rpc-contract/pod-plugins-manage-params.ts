// Fork-only (Pod): params of plugins.install, plugins.remove and the marketplace calls, the RPC
// twins of the desktop's plugins:* IPC (ipc/plugins.ts, ipc/plugin-marketplaces.ts).
import { z } from 'zod'
import { isAllowedPluginGitUrl, PLUGIN_COMMIT_PATTERN } from '../plugins/plugin-install-lockfile'
import { isQualifiedPluginKey } from '../plugins/plugin-manifest'
import { pluginMarketplaceGitSourceSchema } from '../plugins/plugin-marketplace'

const pluginKey = z.string().refine(isQualifiedPluginKey, 'invalid qualified plugin key')
// plugin-marketplace-store.ts's PLUGIN_MARKETPLACE_SOURCE_ID_PATTERN (main can't be imported here).
export const POD_PLUGIN_MARKETPLACE_SOURCE_ID = /^[0-9a-f]{32}$/
const sourceId = z.string().regex(POD_PLUGIN_MARKETPLACE_SOURCE_ID)

/** A folder holding a plugin manifest, or a Git URL at a ref (plugins:install's own rule). */
export const PluginInstallParams = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local-path'), path: z.string().min(1) }),
  z.object({
    kind: z.literal('git'),
    url: z.string().trim().min(1).refine(isAllowedPluginGitUrl, 'git URL must use HTTPS or SSH'),
    // Why: installs must stay reproducible even when callers bypass renderer validation.
    ref: z.string().trim().min(1)
  })
])
export type PluginInstallParams = z.infer<typeof PluginInstallParams>

export const PluginKeyParams = z.object({ pluginKey })

export const PluginMarketplaceAddParams = pluginMarketplaceGitSourceSchema

export const PluginMarketplaceSourceParams = z.strictObject({ sourceId })

export const PluginMarketplaceRefreshParams = z.strictObject({ sourceId: sourceId.optional() })

export const PluginMarketplacePluginParams = z.strictObject({
  marketplaceSourceId: sourceId,
  pluginKey
})

/** What the preview showed: the install refuses a listing that moved since. */
export const PluginMarketplaceInstallParams = PluginMarketplacePluginParams.extend({
  marketplaceCommit: z.string().regex(PLUGIN_COMMIT_PATTERN),
  resolvedCommit: z.string().regex(PLUGIN_COMMIT_PATTERN)
})

export const PluginMarketplaceInstalledParams = z.strictObject({ pluginKey })
