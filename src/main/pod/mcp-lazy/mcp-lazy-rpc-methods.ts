// Fork-only (Pod): podMcpLazy.* — the servers "Lazy-start heavy MCP servers" can wrap, for a native
// Settings page and its one-time hint; the setting itself is podSettings' mcpLazyStart.
import { defineMethod } from '../../runtime/rpc/core'
import { getMcpLazyService, type McpLazyService } from './mcp-lazy-service'

function service(): McpLazyService {
  const value = getMcpLazyService()
  if (!value) {
    throw new Error('Lazy MCP start is off in this build.')
  }
  return value
}

// Why host-admin: ~/.claude.json is the host user's own configuration.
export const POD_MCP_LAZY_METHODS = [
  defineMethod({
    name: 'podMcpLazy.status',
    permission: 'host-admin',
    params: null,
    handler: () => service().status()
  }),
  defineMethod({
    name: 'podMcpLazy.restoreBackup',
    permission: 'host-admin',
    params: null,
    handler: () => service().restoreBackup()
  })
] as const
