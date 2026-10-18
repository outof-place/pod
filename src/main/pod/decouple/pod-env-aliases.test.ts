import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { POD_RENAMED_ORCA_ENV_NAMES } from '../../../shared/pod-env-alias-names'
import {
  POD_ALIASED_ORCA_ENV_NAMES,
  POD_ENV_ALIAS_EXCLUSIONS,
  POD_USER_SETTABLE_ORCA_ENV_NAMES,
  applyPodEnvAliases,
  podSpellingOf
} from '../../../shared/pod-env-aliases'
import { expectPodEnvAliasesConsistent } from './pod-env-aliases.test-support'
import { LEGACY_TERMINAL_SHIM_ENV_KEYS } from '../../pty/legacy-terminal-shim-dir'
import { renderLegacyTerminalPosixTombstone } from '../../pty/legacy-terminal-posix-tombstone'
import {
  renderLegacyTerminalWindowsCmdTombstone,
  renderLegacyTerminalWindowsPowerShellTombstone
} from '../../pty/legacy-terminal-windows-tombstone'

const repoRoot = resolve(__dirname, '..', '..', '..', '..')
const ORCA_NAME = /(?<![A-Za-z0-9_])ORCA_[A-Z0-9_]*[A-Z0-9](?![A-Za-z0-9_])/g

function envNameTable(): { rename: string[] } {
  return JSON.parse(readFileSync(join(repoRoot, 'product/pod-decouple/env-names.json'), 'utf8'))
}

describe('Pod env alias table', () => {
  it('matches the rename list of product/pod-decouple/env-names.json', () => {
    expect([...POD_RENAMED_ORCA_ENV_NAMES]).toEqual(envNameTable().rename)
  })

  it('excludes only renamed names, and aliases every other one', () => {
    const renamed = new Set<string>(POD_RENAMED_ORCA_ENV_NAMES)
    for (const suffix of Object.keys(POD_ENV_ALIAS_EXCLUSIONS)) {
      expect(renamed.has(`ORCA_${suffix}`), suffix).toBe(true)
    }
    expect(POD_ALIASED_ORCA_ENV_NAMES).toHaveLength(
      POD_RENAMED_ORCA_ENV_NAMES.length - Object.keys(POD_ENV_ALIAS_EXCLUSIONS).length
    )
    expect(POD_ALIASED_ORCA_ENV_NAMES).not.toContain('ORCA_VERSION')
  })

  it('lists the 28 user settings, all aliased, none stripped or terminal-scoped', () => {
    const aliased = new Set(POD_ALIASED_ORCA_ENV_NAMES)
    expect(POD_USER_SETTABLE_ORCA_ENV_NAMES).toHaveLength(28)
    expect(new Set(POD_USER_SETTABLE_ORCA_ENV_NAMES).size).toBe(28)
    for (const name of POD_USER_SETTABLE_ORCA_ENV_NAMES) {
      expect(aliased.has(name), name).toBe(true)
    }
    const stripped = new Set<string>(LEGACY_TERMINAL_SHIM_ENV_KEYS)
    expect(POD_USER_SETTABLE_ORCA_ENV_NAMES.filter((name) => stripped.has(name))).toEqual([])
    expect(
      POD_USER_SETTABLE_ORCA_ENV_NAMES.filter((name) =>
        Object.hasOwn(POD_ENV_ALIAS_EXCLUSIONS, name.slice('ORCA_'.length))
      )
    ).toEqual([])
    expect(POD_USER_SETTABLE_ORCA_ENV_NAMES).not.toContain('ORCA_CLI_INSTALL_PATH')
    for (const scoped of ['ORCA_PANE_KEY', 'ORCA_TAB_ID', 'ORCA_AGENT_HOOK_TOKEN']) {
      expect(POD_USER_SETTABLE_ORCA_ENV_NAMES).not.toContain(scoped)
    }
  })

  it('aliases no name a legacy-terminal tombstone unsets', () => {
    const tombstones = [
      renderLegacyTerminalPosixTombstone('git', '/bin/sh'),
      renderLegacyTerminalPosixTombstone('gh', '/bin/sh'),
      renderLegacyTerminalWindowsCmdTombstone('git'),
      renderLegacyTerminalWindowsPowerShellTombstone('gh')
    ]
    const named = new Set(tombstones.flatMap((text) => text.match(ORCA_NAME) ?? []))
    expect(POD_ALIASED_ORCA_ENV_NAMES.filter((name) => named.has(name))).toEqual([])
  })
})

describe('applyPodEnvAliases', () => {
  it("'final' mirrors every aliased ORCA_ and drops a POD_ without one", () => {
    const env: Record<string, string | undefined> = {
      ORCA_PANE_KEY: 'tab-1:pane-1',
      ORCA_TAB_ID: 'tab-1',
      POD_WORKTREE_ID: 'stale',
      POD_VERSION: '1.0.0',
      POD_BENCH_GO: '1',
      ORCA_HISTFILE: '/tmp/history'
    }
    applyPodEnvAliases(env)
    expect(env.POD_PANE_KEY).toBe('tab-1:pane-1')
    expect(env.POD_TAB_ID).toBe('tab-1')
    expect(env).not.toHaveProperty('POD_WORKTREE_ID')
    expect(env.POD_VERSION).toBe('1.0.0')
    expect(env.POD_BENCH_GO).toBe('1')
    expect(env).not.toHaveProperty('POD_HISTFILE')
    expectPodEnvAliasesConsistent(env)
  })

  it('lets a user POD_ setting win over ORCA_ in every mode, and reports its name only', () => {
    for (const mode of ['final', 'request', 'start'] as const) {
      const env: Record<string, string | undefined> = {
        ORCA_GITEA_TOKEN: 'orca-value',
        POD_GITEA_TOKEN: 'pod-value',
        POD_TELEMETRY_DISABLED: '1'
      }
      const adopted = applyPodEnvAliases(env, { mode })
      expect(env.ORCA_GITEA_TOKEN, mode).toBe('pod-value')
      expect(env.POD_GITEA_TOKEN, mode).toBe('pod-value')
      expect(env.ORCA_TELEMETRY_DISABLED, mode).toBe('1')
      expect(adopted, mode).toEqual(['ORCA_GITEA_TOKEN', 'ORCA_TELEMETRY_DISABLED'])
      expect(adopted.join(','), mode).not.toContain('pod-value')
    }
  })

  it("'request' adds no alias and mirrors deletions to the POD_ spelling", () => {
    const envToDelete = ['ORCA_TAB_ID', 'ORCA_GITEA_TOKEN']
    const env: Record<string, string | undefined> = {
      ORCA_PANE_KEY: 'tab-1:pane-1',
      ORCA_TAB_ID: 'tab-1',
      POD_GITEA_TOKEN: 'pod-value'
    }
    applyPodEnvAliases(env, { mode: 'request', envToDelete })
    expect(env).not.toHaveProperty('POD_PANE_KEY')
    expect(env).not.toHaveProperty('ORCA_GITEA_TOKEN')
    expect(envToDelete).toEqual([
      'ORCA_TAB_ID',
      'ORCA_GITEA_TOKEN',
      'POD_GITEA_TOKEN',
      'POD_TAB_ID'
    ])
  })

  it("'start' drops inherited POD_ twins and keeps Pod's own POD_ names", () => {
    const env: Record<string, string | undefined> = {
      POD_PANE_KEY: 'parent-pane',
      POD_TAB_ID: 'parent-tab',
      POD_AGENT_HOOK_PORT: '4242',
      POD_GITEA_TOKEN: 'pod-value',
      POD_BENCH_GO: '1',
      POD_ORCA_IMPORT_SOURCE_DIR: '/tmp/orca'
    }
    applyPodEnvAliases(env, { mode: 'start' })
    expect(env).not.toHaveProperty('POD_PANE_KEY')
    expect(env).not.toHaveProperty('POD_TAB_ID')
    expect(env).not.toHaveProperty('POD_AGENT_HOOK_PORT')
    expect(env.POD_GITEA_TOKEN).toBe('pod-value')
    expect(env.ORCA_GITEA_TOKEN).toBe('pod-value')
    expect(env.POD_BENCH_GO).toBe('1')
    expect(env.POD_ORCA_IMPORT_SOURCE_DIR).toBe('/tmp/orca')
    for (const name of POD_ALIASED_ORCA_ENV_NAMES) {
      if (!POD_USER_SETTABLE_ORCA_ENV_NAMES.includes(name)) {
        expect(env, name).not.toHaveProperty(podSpellingOf(name))
      }
    }
  })

  it('is idempotent', () => {
    const env: Record<string, string | undefined> = {
      ORCA_PANE_KEY: 'tab-1:pane-1',
      POD_GITEA_TOKEN: 'pod-value'
    }
    applyPodEnvAliases(env)
    const once = { ...env }
    expect(applyPodEnvAliases(env)).toEqual([])
    expect(env).toEqual(once)
  })

  it('keeps an env block with every alias far below ARG_MAX', () => {
    const env: Record<string, string> = {}
    for (const name of POD_RENAMED_ORCA_ENV_NAMES) {
      env[name] = 'x'.repeat(256)
    }
    applyPodEnvAliases(env)
    const bytes = Object.entries(env).reduce(
      (sum, [key, value]) => sum + key.length + value.length + 2,
      0
    )
    // Why 256 KiB: Linux ARG_MAX is commonly 2 MiB and macOS 1 MiB, shared with argv.
    expect(bytes).toBeLessThan(256 * 1024)
  })
})
