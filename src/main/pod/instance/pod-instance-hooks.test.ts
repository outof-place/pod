import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ClaudeHookEventVersions from '../../claude/claude-hook-event-versions'

// A dev runtime on this Mac (2026-10-11) had HOME pointed into its profile and still rewrote the
// user's ~/.claude/settings.json: Electron's getPath('home') comes from the user database.
const electron = vi.hoisted(() => {
  const paths: Record<string, string> = {}
  return {
    app: {
      isPackaged: false,
      name: 'Pod Hook Isolation Test',
      paths,
      getPath(name: string): string {
        return this.paths[name] ?? this.paths.scratch
      }
    }
  }
})

vi.mock('electron', () => ({ app: electron.app }))

vi.mock('../../agent-hooks/local-agent-cli-presence', () => ({
  detectLocalManagedAgentCliPresence: async () => ({
    claude: { state: 'found', executablePath: '/opt/claude/bin/claude' }
  })
}))

vi.mock('../../claude/claude-hook-event-versions', async (original) => ({
  ...(await original<typeof ClaudeHookEventVersions>()),
  probeClaudeCliVersion: async () => null
}))

import { installManagedAgentHooks } from '../../agent-hooks/managed-agent-hook-controls'
import { AUTOMATED_LAUNCH_ENV } from '../acc/acc-lifecycle'
import { installPodHookWriteGate, podDefaultUserDataPath } from './pod-instance'

describe("managed hooks from a Pod that isn't the user's own", () => {
  let root: string
  let realHome: string
  let overriddenHome: string
  const saved = Object.fromEntries(
    ['HOME', ...AUTOMATED_LAUNCH_ENV].map((name) => [name, process.env[name]])
  )

  beforeEach(() => {
    // the test runner itself may run as a background launch
    for (const name of AUTOMATED_LAUNCH_ENV) {
      delete process.env[name]
    }
    root = mkdtempSync(join(tmpdir(), 'pod-hook-isolation-'))
    realHome = join(root, 'real-home')
    overriddenHome = join(root, 'profile', 'home')
    mkdirSync(realHome, { recursive: true })
    mkdirSync(overriddenHome, { recursive: true })
    process.env.HOME = overriddenHome
    electron.app.paths = { home: realHome, scratch: join(root, 'scratch') }
    // what main-process-preflight does at startup
    installPodHookWriteGate()
  })

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = value
      }
    }
    rmSync(root, { recursive: true, force: true })
  })

  const written = (home: string) =>
    ['.claude', '.orca'].filter((entry) => existsSync(join(home, entry)))

  it('a dev runtime with HOME moved into its profile writes nothing in either home', async () => {
    electron.app.isPackaged = false
    electron.app.paths.userData = join(root, 'profile')
    const statuses = await installManagedAgentHooks(null, { agents: ['claude'] })
    expect(statuses).toEqual([
      expect.objectContaining({ agent: 'claude', state: 'skipped', skipReason: 'hooks_disabled' })
    ])
    expect(written(realHome)).toEqual([])
    expect(written(overriddenHome)).toEqual([])
  })

  it("the user's own Pod still installs (where its HOME points)", async () => {
    electron.app.isPackaged = true
    electron.app.paths.userData = podDefaultUserDataPath() ?? ''
    const statuses = await installManagedAgentHooks(null, { agents: ['claude'] })
    expect(statuses[0]).toMatchObject({ agent: 'claude', state: 'installed' })
    expect(existsSync(join(overriddenHome, '.claude', 'settings.json'))).toBe(true)
    expect(written(realHome)).toEqual([])
  })

  it('nor a background launch of the packaged app, on its default profile', async () => {
    electron.app.isPackaged = true
    electron.app.paths.userData = podDefaultUserDataPath() ?? ''
    process.env.ORCA_BACKGROUND_LAUNCH = '1'
    const statuses = await installManagedAgentHooks(null, { agents: ['claude'] })
    expect(statuses[0]).toMatchObject({ agent: 'claude', state: 'skipped' })
    expect(written(overriddenHome)).toEqual([])
  })
})
