import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { moveLegacyHome, PRODUCT_HOME_MOVE_RECORD } from './legacy-home-move'

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
  const root = mkdtempSync(join(tmpdir(), 'home-move-'))
  roots.push(root)
  const home = join(root, 'home')
  const userData = join(root, 'userData')
  mkdirSync(home)
  const move = (legacyAppPid: number | null = null) =>
    moveLegacyHome({
      home,
      legacyHomeDirName: LEGACY,
      productHomeDirName: PRODUCT,
      productUserData: userData,
      legacyAppPid,
      now: () => new Date('2026-10-10T06:00:00Z')
    })
  return { home, userData, move }
}

describe('moveLegacyHome', () => {
  it('renames the legacy folder when the product has none, and only once', () => {
    const { home, userData, move } = scratch()
    mkdirSync(join(home, LEGACY, 'agent-hooks'), { recursive: true })
    writeFileSync(join(home, LEGACY, 'keybindings.json'), '[]')
    expect(move()).toEqual({ status: 'moved' })
    expect(readFileSync(join(home, PRODUCT, 'keybindings.json'), 'utf8')).toBe('[]')
    expect(existsSync(join(home, LEGACY))).toBe(false)
    expect(
      JSON.parse(readFileSync(join(userData, PRODUCT_HOME_MOVE_RECORD), 'utf8'))
    ).toMatchObject({ at: '2026-10-10T06:00:00.000Z', result: { status: 'moved' } })
    // A legacy app run afterwards recreates its folder; the product leaves it alone.
    mkdirSync(join(home, LEGACY))
    expect(move()).toEqual({ status: 'not-needed', reason: 'already-recorded' })
    expect(existsSync(join(home, LEGACY))).toBe(true)
  })

  it('merges into an existing product folder without overwriting or taking regenerated files', () => {
    const { home, move } = scratch()
    mkdirSync(join(home, LEGACY, 'agent-hooks'), { recursive: true })
    writeFileSync(join(home, LEGACY, 'keybindings.json'), 'legacy')
    writeFileSync(join(home, LEGACY, 'linear-credentials.json'), 'secret')
    mkdirSync(join(home, PRODUCT))
    writeFileSync(join(home, PRODUCT, 'keybindings.json'), 'product')
    expect(move()).toEqual({
      status: 'merged',
      moved: ['linear-credentials.json'],
      skipped: ['agent-hooks', 'keybindings.json']
    })
    expect(readFileSync(join(home, PRODUCT, 'keybindings.json'), 'utf8')).toBe('product')
    expect(readFileSync(join(home, PRODUCT, 'linear-credentials.json'), 'utf8')).toBe('secret')
    expect(existsSync(join(home, LEGACY, 'agent-hooks'))).toBe(true)
  })

  it('waits while the legacy app runs, without recording', () => {
    const { home, userData, move } = scratch()
    mkdirSync(join(home, LEGACY))
    expect(move(4242)).toEqual({ status: 'deferred', reason: 'legacy-app-running', pid: 4242 })
    expect(existsSync(join(home, LEGACY))).toBe(true)
    expect(existsSync(join(userData, PRODUCT_HOME_MOVE_RECORD))).toBe(false)
  })

  it('records a first run without a legacy folder, and leaves a linked one in place', () => {
    const first = scratch()
    expect(first.move()).toEqual({ status: 'not-needed', reason: 'no-legacy-home' })
    expect(existsSync(join(first.userData, PRODUCT_HOME_MOVE_RECORD))).toBe(true)

    const linked = scratch()
    mkdirSync(join(linked.home, 'shared'))
    symlinkSync(join(linked.home, 'shared'), join(linked.home, LEGACY))
    expect(linked.move()).toEqual({ status: 'not-needed', reason: 'legacy-home-is-a-link' })
    expect(existsSync(join(linked.home, PRODUCT))).toBe(false)
  })
})
