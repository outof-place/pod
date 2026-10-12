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
import { podClaudeFlagSettings } from './pod-claude-flag-settings'
import { PodClaudeHookService } from './pod-claude-hook-service'
import { PodClaudeProfileHookService } from './pod-claude-profile-hook-service'
import { readPodClaudeMigrations } from './pod-claude-settings-migration'

let home = ''
let hooksDir = ''
let settingsPath = ''

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pod-claude-service-'))
  homedirMock.mockReturnValue(home)
  hooksDir = join(home, '.orca', 'agent-hooks')
  settingsPath = join(home, '.claude', 'settings.json')
  const bin = join(home, 'bundle')
  mkdirSync(bin)
  writeFileSync(join(bin, 'pod-agent-hook'), '#!/bin/sh\nprintf "{}\\n"\n', { mode: 0o755 })
  writeFileSync(join(bin, 'pod-agent-launcher'), '#!/bin/sh\n', { mode: 0o755 })
  vi.stubEnv('POD_CLAUDE_FLAG_SETTINGS', '1')
  vi.stubEnv('POD_AGENT_HOOK_BINARY', join(bin, 'pod-agent-hook'))
  vi.stubEnv('POD_AGENT_LAUNCHER_BINARY', join(bin, 'pod-agent-launcher'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

const fallback = (name: 'hooks' | 'statusLine'): string =>
  join(
    hooksDir,
    name === 'hooks' ? 'claude-pod-settings.json' : 'claude-pod-settings-statusline.json'
  )

function settings(): HooksConfig {
  return JSON.parse(readFileSync(settingsPath, 'utf8'))
}

/** settings.json as an earlier Pod left it, around the user's own keys. */
function legacyInstall(user: Record<string, unknown> = { model: 'opus' }): void {
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(settingsPath, `${JSON.stringify(user, null, 2)}\n`)
  expect(new ClaudeHookService().install({ claudeVersion: '2.1.296' }).state).toBe('installed')
}

describe("Pod's Claude hooks through --settings", () => {
  it('writes the files the launcher passes, then takes its entries out of settings.json once', () => {
    legacyInstall()
    expect(settings().hooks?.Stop).toBeDefined()
    const service = new PodClaudeHookService()
    const status = service.install({ claudeVersion: '2.1.296' })
    expect(status).toMatchObject({ state: 'installed', configPath: fallback('hooks') })
    expect(JSON.parse(readFileSync(fallback('hooks'), 'utf8'))).toEqual(
      podClaudeFlagSettings({ home })
    )
    expect(JSON.parse(readFileSync(fallback('statusLine'), 'utf8'))).toEqual(
      podClaudeFlagSettings({ home, statusLine: true })
    )
    expect(settings()).toEqual({ model: 'opus' })
    const [migration] = readPodClaudeMigrations(hooksDir)
    expect(JSON.parse(readFileSync(migration.backupPath, 'utf8')).statusLine).toBeDefined()

    const mtime = statSync(settingsPath).mtimeMs
    const files = readdirSync(hooksDir).sort()
    expect(service.install({ claudeVersion: '2.1.296' }).state).toBe('installed')
    expect(service.getStatus().state).toBe('installed')
    expect(statSync(settingsPath).mtimeMs).toBe(mtime)
    expect(readdirSync(hooksDir).sort()).toEqual(files)
  })

  it("leaves a user's own statusLine where it is", () => {
    const own = { type: 'command', command: 'ccstatusline' }
    legacyInstall({ statusLine: own })
    new PodClaudeHookService().install({ claudeVersion: '2.1.296' })
    expect(settings()).toEqual({ statusLine: own })
  })

  it("keeps Pod's statusLine off for a user who removed it before the move", () => {
    legacyInstall()
    const config = settings()
    delete config.statusLine
    writeFileSync(settingsPath, JSON.stringify(config))
    expect(existsSync(getStatusLineInstallMarkerPath())).toBe(true)
    new PodClaudeHookService().install({ claudeVersion: '2.1.296' })
    expect(existsSync(fallback('hooks'))).toBe(true)
    expect(existsSync(fallback('statusLine'))).toBe(false)
    new PodClaudeHookService().install({ claudeVersion: '2.1.296' })
    expect(existsSync(fallback('statusLine'))).toBe(false)
  })

  it('stays put through an unknown version, and hands back to settings.json for an older Claude', () => {
    legacyInstall()
    const service = new PodClaudeHookService()
    service.install({ claudeVersion: '2.1.296' })
    const migrated = readFileSync(settingsPath, 'utf8')
    expect(service.install({}).state).toBe('installed')
    expect(readFileSync(settingsPath, 'utf8')).toBe(migrated)
    expect(service.install({ claudeVersion: '2.1.200' }).state).toBe('installed')
    expect(existsSync(fallback('hooks'))).toBe(false)
    expect(settings().hooks?.Stop).toBeDefined()
  })

  it("keeps the move on a host without the bundle, such as the CLI's agent-hooks install", () => {
    legacyInstall()
    new PodClaudeHookService().install({ claudeVersion: '2.1.296' })
    const migrated = readFileSync(settingsPath, 'utf8')
    vi.stubEnv('POD_CLAUDE_FLAG_SETTINGS', '')
    vi.stubEnv('POD_AGENT_LAUNCHER_BINARY', '')
    vi.stubEnv('POD_AGENT_HOOK_BINARY', '')
    const service = new PodClaudeHookService()
    expect(service.install({ claudeVersion: '2.1.296' }).state).toBe('installed')
    expect(readFileSync(settingsPath, 'utf8')).toBe(migrated)
    expect(existsSync(fallback('hooks'))).toBe(true)
  })

  it('is ClaudeHookService outside Pod or without the launcher, and remove() takes the files', () => {
    legacyInstall()
    vi.stubEnv('POD_CLAUDE_FLAG_SETTINGS', '0')
    const service = new PodClaudeHookService()
    service.install({ claudeVersion: '2.1.296' })
    expect(existsSync(fallback('hooks'))).toBe(false)
    expect(settings().hooks?.Stop).toBeDefined()
    vi.stubEnv('POD_CLAUDE_FLAG_SETTINGS', '1')
    vi.stubEnv('POD_AGENT_LAUNCHER_BINARY', join(home, 'missing'))
    service.install({ claudeVersion: '2.1.296' })
    expect(existsSync(fallback('hooks'))).toBe(false)
    vi.stubEnv('POD_AGENT_LAUNCHER_BINARY', join(home, 'bundle', 'pod-agent-launcher'))
    service.install({ claudeVersion: '2.1.296' })
    expect(existsSync(fallback('hooks'))).toBe(true)
    service.remove()
    expect(existsSync(fallback('hooks'))).toBe(false)
    expect(existsSync(fallback('statusLine'))).toBe(false)
  })

  it("cleans a profile's settings once the default home has moved, and fills it before", () => {
    const profile = join(home, 'profiles', 'a')
    mkdirSync(profile, { recursive: true })
    // The setup worker's service: no jsonc-parser, no bundle, only the default home's files.
    const worker = new PodClaudeProfileHookService()
    worker.install({ configDir: profile, claudeVersion: '2.1.296' })
    const written = JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8'))
    expect(written.hooks.Stop).toBeDefined()
    new PodClaudeHookService().install({ claudeVersion: '2.1.296' })
    writeFileSync(join(profile, 'settings.json'), JSON.stringify({ ...written, model: 'opus' }))
    expect(worker.install({ configDir: profile, claudeVersion: '2.1.296' }).state).toBe('installed')
    expect(JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8'))).toEqual({
      hooks: {},
      model: 'opus'
    })
  })
})
