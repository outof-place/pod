import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as osModule from 'node:os'
import { parse } from 'jsonc-parser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { homedirMock } = vi.hoisted(() => ({ homedirMock: vi.fn<() => string>() }))

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/orca-user-data' } }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof osModule>()
  return { ...actual, homedir: homedirMock.mockImplementation(actual.homedir) }
})

import type { HooksConfig } from '../../agent-hooks/installer-utils'
import { ClaudeHookService } from '../../claude/hook-service'
import { getStatusLineInstallMarkerPath } from '../../claude/hook-settings'
import { getPodAgentHookInstallPath } from './pod-agent-hook-native'
import {
  getPodClaudeLaunchSettingsPrefix,
  podClaudeLaunchSettingsEnabled,
  podClaudeLaunchSettingsEnv
} from './pod-claude-launch-settings'
import { PodClaudeHookService } from './pod-claude-hook-service'
import { PodClaudeProfileHookService } from './pod-claude-profile-hook-service'
import { readPodClaudeMigrations } from './pod-claude-settings-migration'

let home = ''
let hooksDir = ''
let settingsPath = ''
const realPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
    writable: true
  })
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pod-claude-service-'))
  homedirMock.mockReturnValue(home)
  // Why: the launcher and the client ship for macOS only; Linux CI runs this as macOS.
  setPlatform('darwin')
  hooksDir = join(home, '.orca', 'agent-hooks')
  settingsPath = join(home, '.claude', 'settings.json')
  const bin = join(home, 'bundle')
  mkdirSync(bin)
  writeFileSync(join(bin, 'pod-agent-hook'), '#!/bin/sh\nprintf "{}\\n"\n', { mode: 0o755 })
  writeFileSync(join(bin, 'pod-agent-launcher'), '#!/bin/sh\n', { mode: 0o755 })
  vi.stubEnv('POD_AGENT_HOOK_BINARY', join(bin, 'pod-agent-hook'))
  vi.stubEnv('POD_AGENT_LAUNCHER_BINARY', join(bin, 'pod-agent-launcher'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  vi.unstubAllEnvs()
  setPlatform(realPlatform)
})

const template = (name: string): string => `${getPodClaudeLaunchSettingsPrefix()}.${name}.json`

function readJson(path: string): HooksConfig {
  return parse(readFileSync(path, 'utf8'))
}

/** settings.json as an earlier Pod left it, around the user's own keys. */
function legacyInstall(user: Record<string, unknown> = { model: 'opus' }): void {
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(settingsPath, `${JSON.stringify(user, null, 2)}\n`)
  vi.stubEnv('POD_CLAUDE_LAUNCH_SETTINGS', '0')
  expect(new PodClaudeHookService().install({ claudeVersion: '2.1.296' }).state).toBe('installed')
  vi.stubEnv('POD_CLAUDE_LAUNCH_SETTINGS', '')
}

describe("Pod's Claude hooks with each launch", () => {
  it('is on only where Pod ships its launcher, and can be switched off', () => {
    expect(podClaudeLaunchSettingsEnabled()).toBe(true)
    vi.stubEnv('POD_CLAUDE_LAUNCH_SETTINGS', '0')
    expect(podClaudeLaunchSettingsEnabled()).toBe(false)
    expect(podClaudeLaunchSettingsEnabled({ platform: 'linux', env: {} })).toBe(false)
    expect(
      podClaudeLaunchSettingsEnabled({ env: {}, resourcesPath: join(home, 'Resources') })
    ).toBe(false)
  })

  it('writes the templates, then takes its entries out of settings.json once, byte for byte', () => {
    legacyInstall()
    // The user's edit since: a comment a JSON writer would drop.
    writeFileSync(settingsPath, `// mine\n${readFileSync(settingsPath, 'utf8')}`)
    expect(readFileSync(settingsPath, 'utf8')).toContain('pod-agent-hook')
    const service = new PodClaudeHookService()
    expect(service.install({ claudeVersion: '2.1.296' })).toMatchObject({
      state: 'installed',
      configPath: template('command')
    })
    const migrated = readFileSync(settingsPath, 'utf8')
    expect(migrated.startsWith('// mine\n{\n  "model": "opus"')).toBe(true)
    expect(parse(migrated)).toEqual({ model: 'opus' })
    const [migration] = readPodClaudeMigrations(hooksDir)
    expect(readJson(migration.backupPath).statusLine).toBeDefined()

    const command = readJson(template('command'))
    const http = readJson(template('http'))
    expect(command.hooks?.Stop?.[0]?.hooks?.[0]).toMatchObject({
      type: 'command',
      command: getPodAgentHookInstallPath(),
      args: []
    })
    expect(http.hooks?.SessionStart).toEqual(command.hooks?.SessionStart)
    expect(http.hooks?.TeammateIdle).toEqual(command.hooks?.TeammateIdle)
    expect(http.hooks?.Stop?.[0]?.hooks?.[0]).toEqual({
      type: 'http',
      url: '@@POD_RELAY_URL@@',
      timeout: 10,
      headers: {
        'X-Pod-Hook-Relay-Token': '@@POD_RELAY_TOKEN@@',
        'X-Pod-Hook-Relay-Pane': '@@POD_RELAY_PANE@@',
        'X-Orca-Agent-Process': '@@POD_AGENT_PROCESS@@',
        'X-Pod-Hook-Relay-Job-Dir': '$CLAUDE_JOB_DIR'
      },
      allowedEnvVars: ['CLAUDE_JOB_DIR']
    })
    const statusLine = readJson(template('command-statusline'))
    expect(statusLine.hooks).toEqual(command.hooks)
    expect(JSON.stringify(statusLine.statusLine)).toContain('claude-statusline')
    expect(readJson(template('http-statusline')).hooks).toEqual(http.hooks)
    expect(podClaudeLaunchSettingsEnv()).toEqual({
      POD_CLAUDE_LAUNCH_SETTINGS: getPodClaudeLaunchSettingsPrefix()
    })

    const mtime = statSync(settingsPath).mtimeMs
    const files = readdirSync(hooksDir).sort()
    expect(service.install({ claudeVersion: '2.1.296' }).state).toBe('installed')
    expect(service.getStatus({ claudeVersion: '2.1.296' }).state).toBe('installed')
    expect(statSync(settingsPath).mtimeMs).toBe(mtime)
    expect(readdirSync(hooksDir).sort()).toEqual(files)
  })

  it("leaves a user's own statusLine where it is", () => {
    const own = { type: 'command', command: 'ccstatusline' }
    legacyInstall({ statusLine: own })
    new PodClaudeHookService().install({ claudeVersion: '2.1.296' })
    expect(readJson(settingsPath)).toEqual({ statusLine: own })
  })

  it("keeps Pod's statusLine off for a user who removed it before the move", () => {
    legacyInstall({})
    const config = readJson(settingsPath)
    delete config.statusLine
    writeFileSync(settingsPath, JSON.stringify(config))
    expect(existsSync(getStatusLineInstallMarkerPath())).toBe(true)
    new PodClaudeHookService().install({ claudeVersion: '2.1.296' })
    expect(existsSync(template('command'))).toBe(true)
    expect(existsSync(template('command-statusline'))).toBe(false)
    new PodClaudeHookService().install({ claudeVersion: '2.1.296' })
    expect(existsSync(template('command-statusline'))).toBe(false)
  })

  it('keeps the templates through an unknown version, and on a host without the bundle', () => {
    legacyInstall({})
    const service = new PodClaudeHookService()
    service.install({ claudeVersion: '2.1.296' })
    const http = readFileSync(template('http'), 'utf8')
    expect(service.install({}).state).toBe('installed')
    expect(readFileSync(template('http'), 'utf8')).toBe(http)
    // The CLI's `agent-hooks install`: no launcher next to it, and Pod's hooks stay moved.
    vi.stubEnv('POD_AGENT_LAUNCHER_BINARY', '')
    expect(service.install({ claudeVersion: '2.1.296' }).state).toBe('installed')
    expect(readFileSync(settingsPath, 'utf8')).not.toContain('pod-agent-hook')
  })

  it('writes command hooks into both templates for a Claude without http hooks', () => {
    new PodClaudeHookService().install({ claudeVersion: '2.1.60' })
    expect(readFileSync(template('http'), 'utf8')).toBe(readFileSync(template('command'), 'utf8'))
  })

  it('is ClaudeHookService when switched off, and remove() takes the templates', () => {
    legacyInstall({})
    const service = new PodClaudeHookService()
    service.install({ claudeVersion: '2.1.296' })
    expect(existsSync(template('command'))).toBe(true)
    service.remove()
    expect(existsSync(template('command'))).toBe(false)
    expect(existsSync(template('http-statusline'))).toBe(false)
    expect(podClaudeLaunchSettingsEnv()).toEqual({})
    vi.stubEnv('POD_CLAUDE_LAUNCH_SETTINGS', '0')
    service.install({ claudeVersion: '2.1.296' })
    expect(existsSync(template('command'))).toBe(false)
    expect(readFileSync(settingsPath, 'utf8')).toContain('pod-agent-hook')
  })

  it("cleans a profile's settings once the default home has moved, and fills it before", () => {
    const profile = join(home, 'profiles', 'a')
    mkdirSync(profile, { recursive: true })
    // The setup worker's service: no jsonc-parser, no bundle, only the runtime's templates.
    const worker = new PodClaudeProfileHookService()
    worker.install({ configDir: profile, claudeVersion: '2.1.296' })
    const written = readJson(join(profile, 'settings.json'))
    expect(written.hooks?.Stop).toBeDefined()
    new PodClaudeHookService().install({ claudeVersion: '2.1.296' })
    writeFileSync(join(profile, 'settings.json'), JSON.stringify({ ...written, model: 'opus' }))
    expect(worker.install({ configDir: profile, claudeVersion: '2.1.296' }).state).toBe('installed')
    expect(readJson(join(profile, 'settings.json'))).toEqual({ hooks: {}, model: 'opus' })
  })

  it('leaves the base service alone: ClaudeHookService still writes settings.json', () => {
    vi.stubEnv('POD_CLAUDE_LAUNCH_SETTINGS', '')
    new ClaudeHookService().install({ claudeVersion: '2.1.296' })
    expect(readFileSync(settingsPath, 'utf8')).toContain('pod-agent-hook')
    expect(existsSync(template('command'))).toBe(false)
  })
})
