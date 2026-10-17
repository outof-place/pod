import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  copyLegacyHome,
  PRODUCT_HOME_COPY_RECORD,
  PRODUCT_ONLY_HOOK_ENTRIES
} from './legacy-home-copy'
import { POD_AGENT_HOOK_FILE_NAME } from '../pod/agent-hook/pod-agent-hook-native'
import { POD_AGENT_STATUSLINE_FILE_NAME } from '../pod/agent-hook/pod-statusline-native'
import { MCP_LAZY_FILE_NAME } from '../pod/mcp-lazy/mcp-lazy-binary'

// Why a placeholder name: the decouple codemod rewrites the legacy home's literal in code.
const LEGACY = '.legacy-home'
const PRODUCT = '.product-home'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'home-copy-'))
  roots.push(root)
  const home = join(root, 'home')
  const userData = join(root, 'userData')
  mkdirSync(home)
  const copy = (legacyAppPid: number | null = null) =>
    copyLegacyHome({
      home,
      legacyHomeDirName: LEGACY,
      productHomeDirName: PRODUCT,
      productUserData: userData,
      legacyAppPid,
      now: () => new Date('2026-10-10T06:00:00Z')
    })
  return { home, userData, copy }
}

describe('copyLegacyHome', () => {
  it('copies the legacy entries once and leaves the legacy folder as it was', () => {
    const { home, userData, copy } = scratch()
    mkdirSync(join(home, LEGACY, 'agent-hooks'), { recursive: true })
    writeFileSync(join(home, LEGACY, 'agent-hooks', 'claude-hook.sh'), '#!/bin/sh\n')
    writeFileSync(join(home, LEGACY, 'keybindings.json'), '[]')
    mkdirSync(join(home, LEGACY, 'jira-tokens'))
    writeFileSync(join(home, LEGACY, 'jira-tokens', 'site.enc'), 'secret')
    chmodSync(join(home, LEGACY, 'jira-tokens', 'site.enc'), 0o600)
    const copied = {
      status: 'copied',
      copied: ['jira-tokens', 'keybindings.json'],
      skipped: ['agent-hooks'],
      moved: []
    }
    expect(copy()).toEqual(copied)
    expect(readFileSync(join(home, PRODUCT, 'keybindings.json'), 'utf8')).toBe('[]')
    expect(statSync(join(home, PRODUCT, 'jira-tokens', 'site.enc')).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(home, PRODUCT)).sort()).toEqual(['jira-tokens', 'keybindings.json'])
    expect(readdirSync(join(home, LEGACY)).sort()).toEqual([
      'agent-hooks',
      'jira-tokens',
      'keybindings.json'
    ])
    expect(
      JSON.parse(readFileSync(join(userData, PRODUCT_HOME_COPY_RECORD), 'utf8'))
    ).toMatchObject({ at: '2026-10-10T06:00:00.000Z', result: copied })
    // A legacy app run afterwards writes its folder again; the product leaves it alone.
    writeFileSync(join(home, LEGACY, 'keybindings.json'), '[1]')
    expect(copy()).toEqual({ status: 'not-needed', reason: 'already-recorded' })
    expect(readFileSync(join(home, PRODUCT, 'keybindings.json'), 'utf8')).toBe('[]')
  })

  it('keeps every mode, owner-only folders and key files included', () => {
    const { home, copy } = scratch()
    const legacy = join(home, LEGACY)
    mkdirSync(join(legacy, 'tokens', 'nested'), { recursive: true })
    writeFileSync(join(legacy, 'tokens', 'nested', 'site.enc'), 'secret')
    writeFileSync(join(legacy, 'keybindings.json'), '[]')
    const modes: [string, number][] = [
      [join('tokens', 'nested', 'site.enc'), 0o600],
      [join('tokens', 'nested'), 0o700],
      ['tokens', 0o700],
      ['keybindings.json', 0o644]
    ]
    for (const [path, mode] of modes) {
      chmodSync(join(legacy, path), mode)
    }
    chmodSync(legacy, 0o700)
    expect(copy()).toMatchObject({ status: 'copied', copied: ['keybindings.json', 'tokens'] })
    for (const [path, mode] of modes) {
      expect([path, statSync(join(home, PRODUCT, path)).mode & 0o777]).toEqual([path, mode])
    }
    expect(statSync(join(home, PRODUCT)).mode & 0o777).toBe(0o700)
  })

  it('never overwrites the product folder or takes regenerated files', () => {
    const { home, copy } = scratch()
    mkdirSync(join(home, LEGACY, 'agent-hooks'), { recursive: true })
    writeFileSync(join(home, LEGACY, 'keybindings.json'), 'legacy')
    writeFileSync(join(home, LEGACY, 'linear-credentials.json'), 'secret')
    mkdirSync(join(home, PRODUCT))
    writeFileSync(join(home, PRODUCT, 'keybindings.json'), 'product')
    expect(copy()).toEqual({
      status: 'copied',
      copied: ['linear-credentials.json'],
      skipped: ['agent-hooks', 'keybindings.json'],
      moved: []
    })
    expect(readFileSync(join(home, PRODUCT, 'keybindings.json'), 'utf8')).toBe('product')
    expect(readFileSync(join(home, PRODUCT, 'linear-credentials.json'), 'utf8')).toBe('secret')
    expect(existsSync(join(home, PRODUCT, 'agent-hooks'))).toBe(false)
  })

  it('finishes a copy an earlier launch cut short', () => {
    const { home, copy } = scratch()
    mkdirSync(join(home, LEGACY, 'jira-tokens'), { recursive: true })
    writeFileSync(join(home, LEGACY, 'jira-tokens', 'site.enc'), 'secret')
    mkdirSync(join(home, PRODUCT, '.jira-tokens.pod-copying', 'half'), { recursive: true })
    expect(copy()).toMatchObject({ status: 'copied', copied: ['jira-tokens'] })
    expect(readdirSync(join(home, PRODUCT))).toEqual(['jira-tokens'])
    expect(readFileSync(join(home, PRODUCT, 'jira-tokens', 'site.enc'), 'utf8')).toBe('secret')
  })

  it('waits while the legacy app runs, without recording', () => {
    const { home, userData, copy } = scratch()
    mkdirSync(join(home, LEGACY))
    expect(copy(4242)).toEqual({
      status: 'deferred',
      reason: 'legacy-app-running',
      pid: 4242,
      moved: []
    })
    expect(existsSync(join(home, PRODUCT))).toBe(false)
    expect(existsSync(join(userData, PRODUCT_HOME_COPY_RECORD))).toBe(false)
  })

  it('records a first run without a legacy folder, and leaves a linked one alone', () => {
    const first = scratch()
    expect(first.copy()).toEqual({ status: 'not-needed', reason: 'no-legacy-home' })
    expect(existsSync(join(first.userData, PRODUCT_HOME_COPY_RECORD))).toBe(true)

    const linked = scratch()
    mkdirSync(join(linked.home, 'shared'))
    symlinkSync(join(linked.home, 'shared'), join(linked.home, LEGACY))
    expect(linked.copy()).toEqual({ status: 'not-needed', reason: 'legacy-home-is-a-link' })
    expect(existsSync(join(linked.home, PRODUCT))).toBe(false)
  })
})

/** Every file under `dir` with its bytes, mode and mtime, so a test can prove nothing moved. */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {}
  const walk = (folder: string, prefix: string): void => {
    for (const name of readdirSync(folder).sort()) {
      const path = join(folder, name)
      const stat = lstatSync(path)
      if (stat.isDirectory()) {
        walk(path, `${prefix}${name}/`)
      } else {
        const body = stat.isSymbolicLink() ? `-> ${readlinkSync(path)}` : readFileSync(path, 'hex')
        files[`${prefix}${name}`] = `${stat.mode.toString(8)} ${stat.mtimeMs} ${body}`
      }
    }
  }
  walk(dir, '')
  return files
}

describe('copyLegacyHome: the product-only hook files', () => {
  /** A legacy hook folder both apps wrote into, as on a Mac with Orca.app and Pod. */
  function sharedHookFolder(home: string) {
    const hooks = join(home, LEGACY, 'agent-hooks')
    mkdirSync(hooks, { recursive: true })
    // The legacy app's files, under names both apps write.
    writeFileSync(join(hooks, 'claude-hook.sh'), '#!/bin/sh\necho legacy app\n')
    chmodSync(join(hooks, 'claude-hook.sh'), 0o755)
    writeFileSync(join(hooks, '.orca-managed-scripts.json'), '{"scripts":[]}\n')
    writeFileSync(join(home, LEGACY, 'keybindings.json'), '[]')
    // The product's own.
    writeFileSync(join(hooks, 'pod-agent-hook'), 'native client v1')
    chmodSync(join(hooks, 'pod-agent-hook'), 0o755)
    writeFileSync(join(hooks, 'mcp-lazy'), 'shim v1')
    chmodSync(join(hooks, 'mcp-lazy'), 0o755)
    return hooks
  }

  const legacyAppFiles = (home: string) => {
    const all = snapshot(join(home, LEGACY))
    for (const name of PRODUCT_ONLY_HOOK_ENTRIES) {
      delete all[`agent-hooks/${name}`]
    }
    return all
  }

  it('names exactly the files the product writes there, never a pattern', () => {
    expect(PRODUCT_ONLY_HOOK_ENTRIES).toEqual([
      POD_AGENT_HOOK_FILE_NAME,
      POD_AGENT_STATUSLINE_FILE_NAME,
      MCP_LAZY_FILE_NAME,
      'claude-settings-migration.json'
    ])
  })

  it("moves them and leaves a link behind; the legacy app's files stay byte for byte", () => {
    const { home, copy } = scratch()
    const hooks = sharedHookFolder(home)
    const before = legacyAppFiles(home)

    expect(copy()).toMatchObject({ status: 'copied', moved: ['pod-agent-hook', 'mcp-lazy'] })

    const productHooks = join(home, PRODUCT, 'agent-hooks')
    expect(readdirSync(productHooks).sort()).toEqual(['mcp-lazy', 'pod-agent-hook'])
    for (const name of ['pod-agent-hook', 'mcp-lazy']) {
      expect(lstatSync(join(hooks, name)).isSymbolicLink()).toBe(true)
      expect(readlinkSync(join(hooks, name))).toBe(join(productHooks, name))
      expect(statSync(join(productHooks, name)).mode & 0o777).toBe(0o755)
    }
    // The old path reaches the product's file, which the product updates from now on.
    expect(readFileSync(join(hooks, 'pod-agent-hook'), 'utf8')).toBe('native client v1')
    writeFileSync(join(productHooks, 'pod-agent-hook'), 'native client v2')
    expect(readFileSync(join(hooks, 'pod-agent-hook'), 'utf8')).toBe('native client v2')
    expect(legacyAppFiles(home)).toEqual(before)
    expect(existsSync(join(productHooks, 'claude-hook.sh'))).toBe(false)
  })

  it('changes nothing on a second start, recorded or not', () => {
    const { home, userData, copy } = scratch()
    sharedHookFolder(home)
    copy()
    const legacy = snapshot(join(home, LEGACY))
    const product = snapshot(join(home, PRODUCT))

    expect(copy()).toEqual({ status: 'not-needed', reason: 'already-recorded' })
    rmSync(join(userData, PRODUCT_HOME_COPY_RECORD))
    expect(copy()).toMatchObject({ status: 'copied', moved: [] })

    expect(snapshot(join(home, LEGACY))).toEqual(legacy)
    expect(snapshot(join(home, PRODUCT))).toEqual(product)
  })

  it('moves them while the legacy app runs, since it never writes these names', () => {
    const { home, userData, copy } = scratch()
    const hooks = sharedHookFolder(home)
    const before = legacyAppFiles(home)

    expect(copy(4242)).toEqual({
      status: 'deferred',
      reason: 'legacy-app-running',
      pid: 4242,
      moved: ['pod-agent-hook', 'mcp-lazy']
    })

    expect(lstatSync(join(hooks, 'pod-agent-hook')).isSymbolicLink()).toBe(true)
    expect(legacyAppFiles(home)).toEqual(before)
    expect(existsSync(join(home, PRODUCT, 'keybindings.json'))).toBe(false)
    expect(existsSync(join(userData, PRODUCT_HOME_COPY_RECORD))).toBe(false)
  })

  it('leaves one the product folder already has where it is', () => {
    const { home, copy } = scratch()
    const hooks = sharedHookFolder(home)
    mkdirSync(join(home, PRODUCT, 'agent-hooks'), { recursive: true })
    writeFileSync(join(home, PRODUCT, 'agent-hooks', 'mcp-lazy'), 'shim v2')

    expect(copy()).toMatchObject({ moved: ['pod-agent-hook'] })

    expect(lstatSync(join(hooks, 'mcp-lazy')).isFile()).toBe(true)
    expect(readFileSync(join(hooks, 'mcp-lazy'), 'utf8')).toBe('shim v1')
    expect(readFileSync(join(home, PRODUCT, 'agent-hooks', 'mcp-lazy'), 'utf8')).toBe('shim v2')
  })
})
