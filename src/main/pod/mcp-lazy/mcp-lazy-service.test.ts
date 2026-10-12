import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { listBackups, readUserMcpServers, type ClaudeMcpWriter } from './mcp-lazy-claude-config'
import { isWrapped, type McpServerEntry } from './mcp-lazy-entries'
import { McpLazyService } from './mcp-lazy-service'

let dir: string
let configPath: string
let bundled: string
let installPath: string
let settings: Partial<GlobalSettings>
let listeners: ((updates: Partial<GlobalSettings>) => void)[]

const chrome: McpServerEntry = {
  type: 'stdio',
  command: '/opt/bin/chrome-devtools-mcp',
  args: ['--x'],
  env: {}
}
const mail: McpServerEntry = {
  type: 'stdio',
  command: '/opt/bin/claude-acc',
  args: ['mail', 'mcp'],
  env: {}
}
const remote: McpServerEntry = { type: 'http', url: 'http://127.0.0.1:1/mcp' }

function writeConfig(servers: Record<string, McpServerEntry>): void {
  writeFileSync(
    configPath,
    JSON.stringify({ projects: { '/a': {} }, mcpServers: servers }, null, 2),
    { mode: 0o600 }
  )
}

/** Claude Code's `mcp remove` + `add-json -s user`, on the scratch file. */
const fakeCli: ClaudeMcpWriter = async (name, entry) => {
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  config.mcpServers[name] = entry
  writeFileSync(configPath, JSON.stringify(config, null, 2))
}

function service(writer: ClaudeMcpWriter | null = fakeCli): McpLazyService {
  return new McpLazyService(
    {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the service reads only mcpLazyStart.
      getSettings: () => settings as GlobalSettings,
      onSettingsChanged: (listener) => {
        listeners.push(listener)
        return () => {}
      }
    },
    {
      bundled,
      installPath,
      backupDir: join(dir, 'backups'),
      configPath,
      writer: async () => writer,
      measure: async () => ({}),
      disable: async () => {
        settings = {
          ...settings,
          mcpLazyStart: { enabled: false, servers: settings.mcpLazyStart?.servers ?? [] }
        }
      }
    }
  )
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-lazy-service-'))
  configPath = join(dir, '.claude.json')
  bundled = join(dir, 'bundled-mcp-lazy')
  installPath = join(dir, 'agent-hooks', 'mcp-lazy')
  writeFileSync(bundled, 'shim bytes')
  writeConfig({ chrome, mail, remote })
  settings = {}
  listeners = []
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('McpLazyService', () => {
  it('does nothing at startup while the setting is off', async () => {
    expect(await service().apply('startup')).toBeNull()
    expect(listBackups(join(dir, 'backups'))).toEqual([])
  })

  it('wraps the chosen server, installs the shim, backs up first and keeps the rest', async () => {
    settings = { mcpLazyStart: { enabled: true, servers: ['chrome'] } }
    const result = await service().apply('startup')
    expect(result?.changed).toEqual(['chrome'])
    expect(result?.errors).toEqual([])
    const after = readUserMcpServers(configPath)
    expect(isWrapped(after.chrome)).toBe(true)
    expect(after.mail).toEqual(mail)
    expect(after.remote).toEqual(remote)
    expect(readFileSync(installPath, 'utf8')).toBe('shim bytes')
    expect(statSync(configPath).mode & 0o777).toBe(0o600)
    const [backup] = listBackups(join(dir, 'backups'))
    expect(readUserMcpServers(backup).chrome).toEqual(chrome)
    expect(statSync(backup).mode & 0o777).toBe(0o600)
  })

  it('unwraps when the setting is turned off', async () => {
    settings = { mcpLazyStart: { enabled: true, servers: ['chrome'] } }
    const lazy = service()
    lazy.track()
    await lazy.apply('startup')
    settings = { mcpLazyStart: { enabled: false, servers: ['chrome'] } }
    const result = await lazy.apply('change')
    expect(result?.changed).toEqual(['chrome'])
    expect(readUserMcpServers(configPath).chrome).toEqual(chrome)
  })

  it('leaves ~/.claude.json alone without Claude Code', async () => {
    settings = { mcpLazyStart: { enabled: true, servers: ['chrome'] } }
    const result = await service(null).apply('startup')
    expect(result?.errors[0]).toContain('not found')
    expect(readUserMcpServers(configPath).chrome).toEqual(chrome)
  })

  it('puts entries back when the file ends up other than planned', async () => {
    settings = { mcpLazyStart: { enabled: true, servers: ['chrome'] } }
    const clobbering: ClaudeMcpWriter = async (name, entry) => {
      await fakeCli(name, entry)
      await fakeCli('mail', { command: 'changed meanwhile' })
    }
    const result = await service(clobbering).apply('startup')
    expect(result?.changed).toEqual([])
    expect(result?.errors.join(' ')).toContain('differs from the plan')
    expect(isWrapped(readUserMcpServers(configPath).chrome)).toBe(false)
  })

  it('lists stdio servers with their state, and restores from the backup', async () => {
    settings = { mcpLazyStart: { enabled: true, servers: ['chrome'] } }
    const lazy = service()
    await lazy.apply('startup')
    const status = await lazy.status()
    expect(status.available).toBe(true)
    expect(status.servers.map((row) => [row.name, row.wrapped, row.selected])).toEqual([
      ['chrome', true, true],
      ['mail', false, false]
    ])
    expect(status.servers[0].command).toBe(chrome.command)
    const restored = await lazy.restoreBackup()
    expect(restored.changed).toEqual(['chrome'])
    expect(readUserMcpServers(configPath).chrome).toEqual(chrome)
    expect(settings.mcpLazyStart?.enabled).toBe(false)
  })
})
