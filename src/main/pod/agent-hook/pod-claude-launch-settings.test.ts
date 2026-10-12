import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as osModule from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { homedirMock } = vi.hoisted(() => ({ homedirMock: vi.fn<() => string>() }))

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/orca-user-data' } }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof osModule>()
  return { ...actual, homedir: homedirMock.mockImplementation(actual.homedir) }
})

import type { HooksConfig } from '../../agent-hooks/installer-utils'
import { ClaudeHookService } from '../../claude/hook-service'
import {
  getPodClaudeLaunchSettingsPrefix,
  podClaudeLaunchSettingsEnabled,
  podClaudeLaunchSettingsEnv
} from './pod-claude-launch-settings'
import { getPodAgentHookInstallPath } from './pod-agent-hook-native'

let home = ''
const realPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
    writable: true
  })
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pod-claude-launch-'))
  homedirMock.mockReturnValue(home)
  // Why: the launcher and the client ship for macOS only; Linux CI runs this as macOS.
  setPlatform('darwin')
  const launcher = join(home, 'pod-agent-launcher')
  const client = join(home, 'pod-agent-hook')
  writeFileSync(launcher, '#!/bin/sh\n', { mode: 0o755 })
  writeFileSync(client, '#!/bin/sh\nprintf "{}\\n"\n', { mode: 0o755 })
  vi.stubEnv('POD_AGENT_LAUNCHER_BINARY', launcher)
  vi.stubEnv('POD_AGENT_HOOK_BINARY', client)
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  vi.unstubAllEnvs()
  setPlatform(realPlatform)
})

function readJson(path: string): HooksConfig {
  return JSON.parse(readFileSync(path, 'utf8'))
}

describe("Claude's hooks with each launch in a Pod pane", () => {
  it('is on only where Pod ships its launcher, and can be switched off', () => {
    expect(podClaudeLaunchSettingsEnabled()).toBe(true)
    vi.stubEnv('POD_CLAUDE_LAUNCH_SETTINGS', '0')
    expect(podClaudeLaunchSettingsEnabled()).toBe(false)
    expect(podClaudeLaunchSettingsEnabled({ platform: 'linux', env: {} })).toBe(false)
    expect(
      podClaudeLaunchSettingsEnabled({ env: {}, resourcesPath: join(home, 'Resources') })
    ).toBe(false)
  })

  it("writes the templates, takes Pod's entries out of settings.json once, and keeps the user's", () => {
    const settingsPath = join(home, '.claude', 'settings.json')
    const service = new ClaudeHookService()
    // A Pod that wrote settings.json before: its entries, with the user's own around them.
    vi.stubEnv('POD_CLAUDE_LAUNCH_SETTINGS', '0')
    service.install({ claudeVersion: '2.1.296' })
    vi.unstubAllEnvs()
    vi.stubEnv('POD_AGENT_LAUNCHER_BINARY', join(home, 'pod-agent-launcher'))
    vi.stubEnv('POD_AGENT_HOOK_BINARY', join(home, 'pod-agent-hook'))
    const legacy = readJson(settingsPath)
    legacy.env = { USER_VAR: '1' }
    legacy.hooks!.PreToolUse!.unshift({
      matcher: 'Bash',
      hooks: [{ type: 'command', command: 'rtk hook claude' }]
    })
    writeFileSync(settingsPath, `${JSON.stringify(legacy, null, 2)}\n`)

    expect(service.install({ claudeVersion: '2.1.296' }).state).toBe('installed')
    const migrated = readJson(settingsPath)
    expect(migrated.env).toEqual({ USER_VAR: '1' })
    expect(migrated.hooks?.PreToolUse).toEqual([
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook claude' }] }
    ])
    expect(JSON.stringify(migrated)).not.toContain('pod-agent-hook')
    const bytes = readFileSync(settingsPath, 'utf8')
    const mtime = statSync(settingsPath).mtimeMs
    expect(service.install({ claudeVersion: '2.1.296' }).state).toBe('installed')
    expect(readFileSync(settingsPath, 'utf8')).toBe(bytes)
    expect(statSync(settingsPath).mtimeMs).toBe(mtime)

    const prefix = getPodClaudeLaunchSettingsPrefix()
    const command = readJson(`${prefix}.command.json`)
    const http = readJson(`${prefix}.http.json`)
    expect(command.hooks?.Stop?.[0]?.hooks?.[0]).toMatchObject({
      type: 'command',
      command: getPodAgentHookInstallPath(),
      args: []
    })
    expect(http.hooks?.SessionStart).toEqual(command.hooks?.SessionStart)
    expect(http.hooks?.Stop?.[0]?.hooks?.[0]).toEqual({
      type: 'http',
      url: '@@POD_RELAY_URL@@',
      timeout: 10,
      headers: {
        'X-Pod-Hook-Relay-Token': '@@POD_RELAY_TOKEN@@',
        'X-Pod-Hook-Relay-Pane': '@@POD_RELAY_PANE@@',
        'X-Orca-Agent-Process': '@@POD_AGENT_PROCESS@@'
      }
    })
    expect(Object.keys(http.hooks ?? {}).sort()).toEqual(Object.keys(command.hooks ?? {}).sort())
    expect(podClaudeLaunchSettingsEnv()).toEqual({ POD_CLAUDE_LAUNCH_SETTINGS: prefix })
    expect(service.getStatus({ claudeVersion: '2.1.296' }).state).toBe('installed')
  })

  it('writes command hooks into both templates for a Claude without http hooks', () => {
    new ClaudeHookService().install({ claudeVersion: '2.1.60' })
    const prefix = getPodClaudeLaunchSettingsPrefix()
    expect(readFileSync(`${prefix}.http.json`, 'utf8')).toBe(
      readFileSync(`${prefix}.command.json`, 'utf8')
    )
  })

  it('removing the hooks removes them from the launches too', () => {
    const service = new ClaudeHookService()
    service.install({ claudeVersion: '2.1.296' })
    const prefix = getPodClaudeLaunchSettingsPrefix()
    expect(existsSync(`${prefix}.command.json`)).toBe(true)
    service.remove()
    expect(existsSync(`${prefix}.command.json`)).toBe(false)
    expect(existsSync(`${prefix}.http.json`)).toBe(false)
    expect(podClaudeLaunchSettingsEnv()).toEqual({})
  })
})
