import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { copyLegacyHome, PRODUCT_HOME_COPY_RECORD } from './legacy-home-copy'

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
      skipped: ['agent-hooks']
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
      skipped: ['agent-hooks', 'keybindings.json']
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
    expect(copy(4242)).toEqual({ status: 'deferred', reason: 'legacy-app-running', pid: 4242 })
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
