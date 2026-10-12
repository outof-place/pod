// Fork-only (Pod): "Lazy-start heavy MCP servers" (mcpLazyStart). Wraps the chosen user-scope stdio
// servers of ~/.claude.json in the mcp-lazy shim and unwraps them again. At startup it only wraps;
// a change of the setting also unwraps (see planMcpLazy).
import type { GlobalSettings } from '../../../shared/global-settings-types'
import {
  backupClaudeJson,
  claudeJsonPath,
  listBackups,
  readUserMcpServers,
  writeMcpServers,
  type ClaudeMcpWriter
} from './mcp-lazy-claude-config'
import {
  isHeavy,
  isWrappable,
  isWrapped,
  normalizeMcpLazySetting,
  originalCommand,
  planMcpLazy,
  plannedEntries,
  unwrapEntry,
  type McpServerEntry
} from './mcp-lazy-entries'
import { installMcpLazyBinary } from './mcp-lazy-binary'
import type { McpServerCost } from './mcp-lazy-measure'

export type McpLazyStore = {
  getSettings(): GlobalSettings
  onSettingsChanged(listener: (updates: Partial<GlobalSettings>) => void): () => void
}

export type McpLazyDeps = {
  /** The shim this build ships; null when it has none (not macOS, a checkout without one). */
  bundled: string | null
  /** The copy wrapped entries name. */
  installPath: string
  backupDir: string
  /** ~/.claude.json */
  configPath?: string
  /** Claude Code's CLI writer, or null when no `claude` is found. */
  writer: () => Promise<ClaudeMcpWriter | null>
  measure: (servers: Record<string, McpServerEntry>) => Promise<Record<string, McpServerCost>>
  /** Turns the setting off (restoreBackup), through settings:set's own path. */
  disable: () => Promise<void>
  log?: (message: string) => void
}

export type McpLazyServerStatus = {
  name: string
  command: string
  args: string[]
  wrapped: boolean
  wrappable: boolean
  selected: boolean
  heavy: boolean
  cost?: McpServerCost
}

export type McpLazyApply = { at: number; changed: string[]; errors: string[] }

export type McpLazyStatus = {
  /** A shim to wrap with: this build ships one. */
  available: boolean
  enabled: boolean
  servers: McpLazyServerStatus[]
  lastApply: McpLazyApply | null
  backups: number
}

const MEASURE_TTL_MS = 60_000

export class McpLazyService {
  private queue: Promise<unknown> = Promise.resolve()
  private lastApply: McpLazyApply | null = null
  private measured: { at: number; costs: Record<string, McpServerCost> } | null = null

  constructor(
    private readonly store: McpLazyStore,
    private readonly deps: McpLazyDeps
  ) {}

  /** Applies the setting now (startup) and on every change; returns the unsubscribe. */
  track(): () => void {
    void this.apply('startup')
    return this.store.onSettingsChanged((updates) => {
      if ('mcpLazyStart' in updates) {
        void this.apply('change')
      }
    })
  }

  apply(moment: 'startup' | 'change'): Promise<McpLazyApply | null> {
    const run = this.queue.then(() => this.applyNow(moment))
    this.queue = run.catch(() => {})
    return run
  }

  private async applyNow(moment: 'startup' | 'change'): Promise<McpLazyApply | null> {
    const setting = normalizeMcpLazySetting(this.store.getSettings().mcpLazyStart)
    if (moment === 'startup' && !setting.enabled) {
      return null
    }
    const configPath = this.deps.configPath ?? claudeJsonPath()
    const record = (changed: string[], errors: string[]): McpLazyApply => {
      this.lastApply = { at: Date.now(), changed, errors }
      this.deps.log?.(
        `mcp-lazy ${moment}: changed [${changed.join(', ')}]${errors.length ? `, ${errors.length} error(s)` : ''}`
      )
      return this.lastApply
    }
    try {
      const servers = readUserMcpServers(configPath)
      const plan = planMcpLazy(servers, setting, this.deps.installPath, moment)
      if (plan.wrap.length === 0 && plan.unwrap.length === 0) {
        return null
      }
      if (plan.wrap.length > 0) {
        if (!this.deps.bundled) {
          return record([], ['This build has no mcp-lazy shim.'])
        }
        installMcpLazyBinary(this.deps.bundled, this.deps.installPath)
      }
      const writer = await this.deps.writer()
      if (!writer) {
        return record([], ['Claude Code (claude) was not found, so ~/.claude.json was left alone.'])
      }
      backupClaudeJson(this.deps.backupDir, configPath)
      const result = await writeMcpServers(
        servers,
        plannedEntries(servers, plan, this.deps.installPath),
        writer,
        configPath
      )
      return record(result.changed, result.errors)
    } catch (error) {
      return record([], [error instanceof Error ? error.message : String(error)])
    }
  }

  async status(): Promise<McpLazyStatus> {
    const setting = normalizeMcpLazySetting(this.store.getSettings().mcpLazyStart)
    let servers: Record<string, McpServerEntry> = {}
    try {
      servers = readUserMcpServers(this.deps.configPath ?? claudeJsonPath())
    } catch {
      // Unreadable: the list stays empty and lastApply says why once a write is tried.
    }
    if (!this.measured || Date.now() - this.measured.at > MEASURE_TTL_MS) {
      const costs = await this.deps.measure(servers).catch(() => ({}))
      this.measured = { at: Date.now(), costs }
    }
    const costs = this.measured.costs
    const rows: McpLazyServerStatus[] = []
    for (const [name, entry] of Object.entries(servers)) {
      const original = originalCommand(entry)
      if (!original || !(isWrappable(entry) || isWrapped(entry))) {
        continue
      }
      rows.push({
        name,
        command: original.command,
        args: original.args,
        wrapped: isWrapped(entry),
        wrappable: isWrappable(entry),
        selected: setting.servers.includes(name),
        heavy: isHeavy(entry),
        ...(costs[name] ? { cost: costs[name] } : {})
      })
    }
    return {
      available: this.deps.bundled !== null,
      enabled: setting.enabled,
      servers: rows,
      lastApply: this.lastApply,
      backups: listBackups(this.deps.backupDir).length
    }
  }

  /** Turns the setting off and gives every wrapped entry back the one in the newest backup. */
  restoreBackup(): Promise<McpLazyApply> {
    const run = this.queue.then(async () => {
      await this.deps.disable()
      const configPath = this.deps.configPath ?? claudeJsonPath()
      const newest = listBackups(this.deps.backupDir)[0]
      const saved = newest ? readUserMcpServers(newest) : {}
      const servers = readUserMcpServers(configPath)
      const planned: Record<string, McpServerEntry> = {}
      for (const [name, entry] of Object.entries(servers)) {
        if (isWrapped(entry)) {
          planned[name] = saved[name] && !isWrapped(saved[name]) ? saved[name] : unwrapEntry(entry)
        }
      }
      const writer = await this.deps.writer()
      if (!writer) {
        this.lastApply = {
          at: Date.now(),
          changed: [],
          errors: ['Claude Code (claude) was not found.']
        }
        return this.lastApply
      }
      const result = await writeMcpServers(servers, planned, writer, configPath)
      this.lastApply = { at: Date.now(), ...result }
      return this.lastApply
    })
    this.queue = run.catch(() => {})
    return run
  }
}

let service: McpLazyService | null = null

export function setMcpLazyService(value: McpLazyService | null): void {
  service = value
}

export function getMcpLazyService(): McpLazyService | null {
  return service
}
