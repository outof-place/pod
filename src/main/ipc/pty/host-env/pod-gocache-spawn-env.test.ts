import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BuildPtyHostEnvOptions } from './types'

const fixture = vi.hoisted(() => ({ userData: '' }))
vi.mock('../../../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: () => fixture.userData, onWillQuit: vi.fn() })
}))
vi.mock('../../../agent-hooks/server', () => ({
  agentHookServer: { buildPtyEnv: () => ({ ORCA_AGENT_HOOK_PORT: '12345' }) }
}))
vi.mock('../../../agent-hooks/wsl-hook-relay-manager', () => ({
  wslHookRelayManager: {
    ensureForDistro: vi.fn(),
    getGuestEndpointFilePath: () => '/guest/endpoint.json',
    getOpenCodeOverlayDir: () => null,
    getGuestAgentPath: () => null
  }
}))
vi.mock('../../../pi/titlebar-extension-service', () => ({
  piTitlebarExtensionService: { buildPtyEnv: () => ({}), buildFreshOmpEnv: () => ({}) }
}))
vi.mock('../../../cli/orca-cli-child-path', () => ({ prependOrcaCliDirToChildPath: () => {} }))
vi.mock('../../../cli/wsl-managed-cli', () => ({
  getManagedWslCliDir: () => undefined,
  getWslCliCommandName: () => 'orca-ide'
}))
vi.mock('../../../codex/codex-hook-reconcile', () => ({ scheduleCodexHookReconcile: vi.fn() }))

import { buildPtyHostEnv } from './assembly'
import { setPodGoCacheSettingReader } from '../../../pod/gocache/pod-gocache-pty-env'

// Why this file: GOCACHEPROG names a macOS binary and a unix socket under this host's home, so
// only local macOS terminals get it, only while the installed helper can actually run, and for now
// only with Pod's dev opt-in (POD_GOCACHE_TERMINAL_ENV=1).

let root: string
let home: string
let options: BuildPtyHostEnvOptions
const realPlatform = process.platform

function installHelper(at = home): string {
  const helper = join(at, '.pod/gocache/bin/pod-gocache')
  mkdirSync(join(helper, '..'), { recursive: true })
  writeFileSync(helper, '#!/bin/sh\n')
  chmodSync(helper, 0o755)
  return helper
}

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pod-gocache-spawn-env-'))
  home = join(root, 'home')
  mkdirSync(home)
  fixture.userData = join(root, 'user-data')
  vi.stubEnv('HOME', home)
  vi.stubEnv('POD_GOCACHE', undefined)
  vi.stubEnv('POD_GOCACHE_TERMINAL_ENV', undefined)
  vi.stubEnv('GOCACHEPROG', undefined)
  setPlatform('darwin')
  setPodGoCacheSettingReader(() => true)
  options = {
    isPackaged: true,
    userDataPath: fixture.userData,
    selectedCodexHomePath: null,
    agentStatusHooksEnabled: false
  }
})

afterEach(() => {
  setPlatform(realPlatform)
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

describe('GOCACHEPROG in a terminal', () => {
  it('none by default, even with the helper installed and the setting on', () => {
    installHelper()

    expect(buildPtyHostEnv('local-pane', {}, options).GOCACHEPROG).toBeUndefined()
  })

  it("never changes a user's own GOCACHEPROG by default", () => {
    installHelper()
    const own = '/opt/tools/my-cache prog'

    expect(buildPtyHostEnv('local-pane', { GOCACHEPROG: own }, options).GOCACHEPROG).toBe(own)
  })
})

describe('GOCACHEPROG in a terminal, opted in with POD_GOCACHE_TERMINAL_ENV=1', () => {
  beforeEach(() => {
    vi.stubEnv('POD_GOCACHE_TERMINAL_ENV', '1')
  })

  it('a local macOS terminal runs go through the installed helper', () => {
    const helper = installHelper()

    const env = buildPtyHostEnv('local-pane', {}, options)

    expect(env.GOCACHEPROG).toBe(`${helper} prog`)
  })

  it('never a WSL terminal', () => {
    installHelper()

    const env = buildPtyHostEnv('wsl-pane', {}, { ...options, isWsl: true, wslDistro: 'Ubuntu' })

    expect(env.GOCACHEPROG).toBeUndefined()
  })

  it('never off macOS, where the helper means nothing', () => {
    installHelper()
    setPlatform('linux')

    expect(buildPtyHostEnv('linux-pane', {}, options).GOCACHEPROG).toBeUndefined()
  })

  it.each([
    ['is not installed', () => {}],
    ['lost its executable bit', () => chmodSync(installHelper(), 0o644)],
    [
      'is a directory',
      () => mkdirSync(join(home, '.pod/gocache/bin/pod-gocache'), { recursive: true })
    ]
  ])('never while the helper %s: go would fail to start it', (_name, arrange) => {
    arrange()

    expect(buildPtyHostEnv('local-pane', {}, options).GOCACHEPROG).toBeUndefined()
  })

  it('never fails the spawn when the helper cannot even be looked at', () => {
    const helper = installHelper()
    const bin = join(helper, '..')
    chmodSync(bin, 0o000)
    try {
      expect(buildPtyHostEnv('local-pane', {}, options).GOCACHEPROG).toBeUndefined()
    } finally {
      chmodSync(bin, 0o755)
    }
  })

  it.each([
    ['POD_GOCACHE=0', () => vi.stubEnv('POD_GOCACHE', '0')],
    ['POD_GOCACHE=off', () => vi.stubEnv('POD_GOCACHE', 'off')],
    ['the setting', () => setPodGoCacheSettingReader(() => false)]
  ])(
    'never while %s turns it off, and drops the copy a parent terminal passed down',
    (_name, turnOff) => {
      const helper = installHelper()
      turnOff()

      const env = buildPtyHostEnv('local-pane', { GOCACHEPROG: `${helper} prog` }, options)

      expect(env.GOCACHEPROG).toBeUndefined()
    }
  )

  it("keeps the user's own GOCACHEPROG, on or off", () => {
    installHelper()
    const own = '/opt/tools/my-cache prog --verbose'

    expect(buildPtyHostEnv('on', { GOCACHEPROG: own }, options).GOCACHEPROG).toBe(own)
    vi.stubEnv('POD_GOCACHE', '0')
    expect(buildPtyHostEnv('off', { GOCACHEPROG: own }, options).GOCACHEPROG).toBe(own)
  })

  it("keeps a GOCACHEPROG Pod itself was started with: the PTY inherits it, so it is the user's", () => {
    installHelper()
    vi.stubEnv('GOCACHEPROG', '/opt/tools/my-cache prog')

    expect(buildPtyHostEnv('local-pane', {}, options).GOCACHEPROG).toBeUndefined()
  })

  it('never in a process that did not install the switch (orcad, other tests)', async () => {
    installHelper()
    vi.resetModules()
    const fresh = await import('../../../pod/gocache/pod-gocache-pty-env')
    const env: Record<string, string> = {}

    fresh.applyPodGoCachePtyEnv(env, { isWsl: false })

    expect(env.GOCACHEPROG).toBeUndefined()
  })

  it.each([
    ['a space', 'John Smith', (helper: string) => `'${helper}' prog`],
    ['a single quote', "O'Brien", (helper: string) => `"${helper}" prog`]
  ])(
    'quotes a home with %s the way go splits GOCACHEPROG (cmd/internal/quoted)',
    (_name, user, expected) => {
      const odd = join(root, user)
      vi.stubEnv('HOME', odd)
      const helper = installHelper(odd)

      expect(buildPtyHostEnv('local-pane', {}, options).GOCACHEPROG).toBe(expected(helper))
    }
  )

  it('sets nothing for a home with both quote kinds, which go cannot split back', () => {
    const odd = join(root, `O'Brien "Jr"`)
    vi.stubEnv('HOME', odd)
    installHelper(odd)

    expect(buildPtyHostEnv('local-pane', {}, options).GOCACHEPROG).toBeUndefined()
  })
})
