// Fork-only (Pod): the env a shell launch adds is the wrapper's to consume and unset, and the
// local fallback (local-pty-utils.ts) rewrites it after the final alias point, so none of it may
// carry a POD_ alias: a POD_ twin would outlive the ORCA_ name the wrapper takes off.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getRelayShellLaunchConfig } from '../../../relay/pty-shell-launch'
import { POD_ALIASED_ORCA_ENV_NAMES, podSpellingOf } from '../../../shared/pod-env-aliases'
import { getShellLaunchConfig as getDaemonShellLaunchConfig } from '../../daemon/shell-ready'
import { getShellLaunchConfig as getLocalShellLaunchConfig } from '../../providers/local-pty-shell-ready'
import { SHELL_STARTUP_FEATURES, type ShellStartupFeature } from '../../shell-startup-features'

const SHELLS = ['/bin/zsh', '/bin/bash', '/opt/homebrew/bin/fish', '/bin/sh']
const FEATURE_SETS: readonly (readonly ShellStartupFeature[])[] = [
  [],
  ...SHELL_STARTUP_FEATURES.map((feature) => [feature]),
  SHELL_STARTUP_FEATURES
]
const INHERITED_XDG_DATA_DIRS = [undefined, '/usr/local/share:/usr/share']

const describePosix = process.platform === 'win32' ? describe.skip : describe

describePosix('shell launch env and the POD_ aliases', () => {
  const saved = { userData: process.env.ORCA_USER_DATA_PATH, zdotdir: process.env.ZDOTDIR }
  let root = ''
  let userZdotdir = ''

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'pod-env-alias-shell-ready-'))
    // Why a user ZDOTDIR with a .zshrc: only a usable one makes the launch hand it back.
    userZdotdir = join(root, 'user-zdotdir')
    mkdirSync(userZdotdir)
    writeFileSync(join(userZdotdir, '.zshrc'), '')
    process.env.ORCA_USER_DATA_PATH = join(root, 'user-data')
    process.env.ZDOTDIR = userZdotdir
  })

  afterAll(() => {
    for (const [name, value] of [
      ['ORCA_USER_DATA_PATH', saved.userData],
      ['ZDOTDIR', saved.zdotdir]
    ] as const) {
      if (value === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = value
      }
    }
  })

  function launchKeysByTransport(): Record<'local' | 'daemon' | 'relay', Set<string>> {
    const keys = { local: new Set<string>(), daemon: new Set<string>(), relay: new Set<string>() }
    for (const shell of SHELLS) {
      for (const features of FEATURE_SETS) {
        for (const inheritedXdgDataDirs of INHERITED_XDG_DATA_DIRS) {
          for (const startupCommand of [undefined, 'codex']) {
            const local = getLocalShellLaunchConfig(shell, features, startupCommand, {
              inheritedXdgDataDirs
            })
            Object.keys(local.env).forEach((key) => keys.local.add(key))
            const daemon = getDaemonShellLaunchConfig(shell, features, {
              hasStartupCommand: startupCommand !== undefined,
              inheritedXdgDataDirs
            })
            Object.keys(daemon.env).forEach((key) => keys.daemon.add(key))
          }
        }
      }
      const overlays: Record<string, string>[] = [{}, { ORCA_CODEX_HOME: join(root, 'codex-home') }]
      for (const overlay of overlays) {
        for (const emitReadyMarker of [false, true]) {
          for (const emitStartupIdentity of [false, true]) {
            const relay = getRelayShellLaunchConfig(
              shell,
              { HOME: join(root, 'relay-home'), ZDOTDIR: userZdotdir, ...overlay },
              'darwin',
              { emitReadyMarker, emitStartupIdentity }
            )
            Object.keys(relay.env).forEach((key) => keys.relay.add(key))
          }
        }
      }
    }
    return keys
  }

  it('adds no aliased name and no POD_ spelling of one, on any transport', () => {
    const aliased = new Set(POD_ALIASED_ORCA_ENV_NAMES)
    const podSpellings = new Set(POD_ALIASED_ORCA_ENV_NAMES.map(podSpellingOf))
    for (const [transport, keys] of Object.entries(launchKeysByTransport())) {
      expect(
        [...keys].filter((key) => aliased.has(key) || podSpellings.has(key)),
        transport
      ).toEqual([])
    }
  })

  it('covers every key each transport writes (a new launch key must be filed here)', () => {
    const keys = launchKeysByTransport()
    expect([...keys.local].sort()).toEqual([
      'ORCA_FISH_XDG_DATA_DIRS_PREFIX',
      'ORCA_ORIG_ZDOTDIR',
      'ORCA_POSIX_SHELL_STARTUP_COMMAND',
      'ORCA_SHELL_FEATURES',
      'XDG_DATA_DIRS',
      'ZDOTDIR'
    ])
    expect([...keys.daemon].sort()).toEqual([
      'ORCA_FISH_XDG_DATA_DIRS_PREFIX',
      'ORCA_ORIG_ZDOTDIR',
      'ORCA_SHELL_FEATURES',
      'XDG_DATA_DIRS',
      'ZDOTDIR'
    ])
    expect([...keys.relay].sort()).toEqual(['ORCA_ORIG_ZDOTDIR', 'ORCA_SHELL_FEATURES', 'ZDOTDIR'])
  })
})
