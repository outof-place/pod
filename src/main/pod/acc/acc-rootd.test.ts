import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ACC_STATE_DIR } from './acc-lifecycle'
import { ACC_ROOTD_REQUEST, takeAccRootdRequest } from './acc-rootd'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

const NOW = new Date(1_760_000_000_000)

/** A home whose $STATE holds `body` as the request, written the way AccKit writes it (0600). */
function home(body: unknown, mode = 0o600): { home: string; request: string } {
  const root = mkdtempSync(join(tmpdir(), 'pod-acc-rootd-'))
  roots.push(root)
  const state = join(root, ACC_STATE_DIR)
  mkdirSync(state, { recursive: true })
  const request = join(state, ACC_ROOTD_REQUEST)
  if (body !== undefined) {
    writeFileSync(request, JSON.stringify(body), { mode })
    chmodSync(request, mode)
  }
  return { home: root, request }
}

describe('pod-rootd requests from the panel', () => {
  it('takes a fresh enable request of this account', () => {
    const { home: h, request } = home({ action: 'enable', at: NOW.getTime() / 1000 - 30 })
    expect(takeAccRootdRequest(h, NOW)).toBe(true)
    expect(existsSync(request)).toBe(false)
    expect(takeAccRootdRequest(h, NOW)).toBe(false)
  })

  it.each([
    ['a stale one', { action: 'enable', at: NOW.getTime() / 1000 - 6 * 60 }, 0o600],
    ['one from the future', { action: 'enable', at: NOW.getTime() / 1000 + 120 }, 0o600],
    ['another action', { action: 'disable', at: NOW.getTime() / 1000 }, 0o600],
    ['one without a time', { action: 'enable' }, 0o600],
    ['one others can write', { action: 'enable', at: NOW.getTime() / 1000 }, 0o620]
  ])('refuses and removes %s', (_name, body, mode) => {
    const { home: h, request } = home(body, mode)
    expect(takeAccRootdRequest(h, NOW)).toBe(false)
    expect(existsSync(request)).toBe(false)
  })

  it("refuses a request another account's process could have left", () => {
    const { home: h } = home({ action: 'enable', at: NOW.getTime() / 1000 })
    expect(takeAccRootdRequest(h, NOW, (process.getuid?.() ?? 0) + 1)).toBe(false)
  })

  it('never follows a symlink, and leaves its target alone', () => {
    const { home: h, request } = home(undefined)
    const target = join(h, 'elsewhere.json')
    writeFileSync(target, JSON.stringify({ action: 'enable', at: NOW.getTime() / 1000 }), {
      mode: 0o600
    })
    symlinkSync(target, request)
    expect(takeAccRootdRequest(h, NOW)).toBe(false)
    expect(existsSync(target)).toBe(true)
  })

  it('finds nothing when no one asked', () => {
    expect(takeAccRootdRequest(home(undefined).home, NOW)).toBe(false)
  })
})
