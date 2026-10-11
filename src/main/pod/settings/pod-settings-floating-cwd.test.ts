// Fork-only (Pod): podSettings.set writes floatingTerminalCwd through settings:set's sanitizer.
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../../config/scripts/vitest-host-ports-setup'
import type { GlobalSettings } from '../../../shared/global-settings-types'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/test/user-data'), isPackaged: false },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  nativeTheme: { themeSource: 'system' }
}))
vi.mock('../../ghostty/index', () => ({ previewGhosttyImport: vi.fn() }))
vi.mock('../../warp-themes', () => ({ previewWarpThemeImport: vi.fn() }))
vi.mock('../../network/proxy-settings', () => ({ applyElectronProxySettings: vi.fn() }))
vi.mock('../../browser/browser-session-proxy', () => ({ applyBrowserSessionProxies: vi.fn() }))
vi.mock('../../browser/browser-session-registry', () => ({
  browserSessionRegistry: { listProfiles: vi.fn(() => []) }
}))
vi.mock('../../app-icon', () => ({ applyAppIcon: vi.fn() }))
vi.mock('../../ai-vault-search/session-search-enablement', () => ({
  applySessionSearchSettingsChange: vi.fn()
}))
vi.mock('../../agent-hooks/managed-agent-hook-controls', () => ({
  applyAgentStatusHooksEnabled: vi.fn(async () => [])
}))
vi.mock('../../worktree-root-preparation', () => ({ prepareLocalWorktreeRootsForRepos: vi.fn() }))
vi.mock('../../menu/register-app-menu', () => ({ rebuildAppMenu: vi.fn() }))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))

import { registerSettingsHandlers } from '../../ipc/settings'
import { getPodSettingsWriter } from './pod-settings-writer'

describe('podSettings.set and the floating terminal folder', () => {
  let root: string
  let settings: Partial<GlobalSettings>
  const store = {
    getSettings: () => settings,
    updateSettings: (updates: Partial<GlobalSettings>) => (settings = { ...settings, ...updates }),
    updateSettingsAndFlush: vi.fn(),
    getGitHubCache: vi.fn(),
    setGitHubCache: vi.fn(),
    onSettingsChanged: vi.fn(() => () => {})
  }

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pod-floating-cwd-')))
    await mkdir(path.join(root, 'picked'))
    await mkdir(path.join(root, 'typed'))
    installFakeAppEnvironment({ getPath: () => root })
    settings = {
      floatingTerminalCwd: '~',
      floatingTerminalTrustedCwds: [path.join(root, 'picked')]
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the write path uses only the settings methods above.
    registerSettingsHandlers(store as never)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('keeps home and picked folders, clears a typed one, and never adds trust', async () => {
    const write = getPodSettingsWriter()
    expect(write).not.toBeNull()
    await write?.({ floatingTerminalCwd: path.join(root, 'typed') })
    expect(settings.floatingTerminalCwd).toBe('')
    await write?.({ floatingTerminalCwd: path.join(root, 'picked') })
    expect(settings.floatingTerminalCwd).toBe(path.join(root, 'picked'))
    await write?.({ floatingTerminalCwd: '~' })
    expect(settings.floatingTerminalCwd).toBe('~')
    expect(settings.floatingTerminalTrustedCwds).toEqual([path.join(root, 'picked')])
  })
})
