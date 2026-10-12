// Fork-only (Pod): starts "Lazy-start heavy MCP servers" for a Pod build (podSettings' identity).
import { app } from 'electron'
import { join } from 'node:path'
import type { Store } from '../../persistence'
import { detectLocalManagedAgentCliPresence } from '../../agent-hooks/local-agent-cli-presence'
import { getManagedAgentHookTarget } from '../../../shared/managed-agent-hook-targets'
import { isPodSettingsRpcEnabled } from '../settings/install-pod-settings'
import { getPodSettingsWriter } from '../settings/pod-settings-writer'
import { getMcpLazyInstallPath, resolveBundledMcpLazy } from './mcp-lazy-binary'
import { claudeCliWriter } from './mcp-lazy-claude-config'
import { measureMcpServers } from './mcp-lazy-measure'
import { McpLazyService, setMcpLazyService } from './mcp-lazy-service'

export function installMcpLazy(store: Store): void {
  if (!isPodSettingsRpcEnabled() || process.platform !== 'darwin') {
    return
  }
  const service = new McpLazyService(store, {
    bundled: resolveBundledMcpLazy(),
    installPath: getMcpLazyInstallPath(),
    backupDir: join(app.getPath('userData'), 'mcp-lazy', 'backups'),
    writer: async () => {
      const target = getManagedAgentHookTarget('claude')
      if (!target) {
        return null
      }
      const presence = await detectLocalManagedAgentCliPresence([target], store.getSettings())
      const claude = presence.claude
      return claude?.state === 'found' ? claudeCliWriter(claude.executablePath) : null
    },
    measure: measureMcpServers,
    disable: async () => {
      const write = getPodSettingsWriter()
      if (write) {
        const current = store.getSettings().mcpLazyStart
        await write({ mcpLazyStart: { enabled: false, servers: current?.servers ?? [] } })
      }
    },
    log: (message) => console.info(`[pod-mcp-lazy] ${message}`)
  })
  setMcpLazyService(service)
  service.track()
}
