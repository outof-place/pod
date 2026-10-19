// Fork-only (Pod): only an E2E run of an unpackaged app (isolated profile, a HOME that isn't the
// account's directory) admits PodNative's measure build and checks peers without product identity;
// the user's own profile and every packaged app keep the shipped rule.
import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { Socket } from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ProductIdentityModule from '../../product-identity/product-identity'
import { POD_UI_PEER_REQUIREMENT } from '../ui-host/pod-peer-identity'
import {
  isPodNativePeerE2ERun,
  POD_NATIVE_PEER_E2E_REQUIREMENT,
  podNativePeerCheck,
  podNativePeerRequirement,
  setPodNativePeerUnpackagedApp,
  setPodNativePeerVerifierLoader
} from './pod-native-peer'

vi.mock('../../product-identity/product-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof ProductIdentityModule>()),
  getProductIdentity: () => null
}))

const E2E_ENV = { ORCA_E2E_USER_DATA_DIR: '/private/tmp/pod-e2e/profile' }

// An account home and an isolated one, as real directories: the check compares dev and inode.
let account = ''
let isolated = ''

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'pod-native-peer-e2e-'))
  account = join(root, 'account')
  isolated = join(root, 'isolated')
  mkdirSync(join(account, 'sub'), { recursive: true })
  mkdirSync(isolated)
})

afterEach(() => {
  setPodNativePeerVerifierLoader(null)
  setPodNativePeerUnpackagedApp(false)
  vi.unstubAllEnvs()
})

describe('isPodNativePeerE2ERun', () => {
  it('holds for an unpackaged app with the isolated profile and another directory as HOME', () => {
    expect(isPodNativePeerE2ERun(E2E_ENV, isolated, account, true)).toBe(true)
  })

  it('never holds for a packaged app, whatever its env and HOME', () => {
    expect(isPodNativePeerE2ERun(E2E_ENV, isolated, account, false)).toBe(false)
  })

  it.each([
    ['the account home itself', () => account],
    ['a trailing slash', () => `${account}/`],
    ['a `..` back into it', () => join(account, 'sub', '..')],
    [
      'a symlink to it',
      () => {
        const link = join(isolated, 'link-to-account')
        symlinkSync(account, link)
        return link
      }
    ],
    // APFS is case-insensitive by default; on a case-sensitive volume this path doesn't exist,
    // and a failed stat counts as the account's home too.
    ['another letter case', () => account.toUpperCase()],
    ['a HOME that does not exist', () => join(isolated, 'missing')]
  ])('does not hold when HOME is %s', (_what, home) => {
    expect(isPodNativePeerE2ERun(E2E_ENV, home(), account, true)).toBe(false)
  })

  it('needs the isolated profile and an account home', () => {
    expect(isPodNativePeerE2ERun({}, isolated, account, true)).toBe(false)
    expect(isPodNativePeerE2ERun(E2E_ENV, isolated, null, true)).toBe(false)
  })
})

describe('podNativePeerRequirement', () => {
  it('admits the measure build only in an E2E run, under the same team', () => {
    expect(podNativePeerRequirement(false)).toBe(POD_UI_PEER_REQUIREMENT)
    expect(POD_UI_PEER_REQUIREMENT).not.toContain('codes.pod.native.measure')
    expect(podNativePeerRequirement(true)).toBe(POD_NATIVE_PEER_E2E_REQUIREMENT)
    expect(POD_NATIVE_PEER_E2E_REQUIREMENT).toContain('identifier "codes.pod.native.measure"')
    expect(POD_NATIVE_PEER_E2E_REQUIREMENT).toContain(
      'anchor apple generic and certificate leaf[subject.OU] = "75Y2KR6P5W"'
    )
  })

  it('keeps the shipped rule for a packaged app with both E2E variables set', () => {
    vi.stubEnv('ORCA_E2E_USER_DATA_DIR', E2E_ENV.ORCA_E2E_USER_DATA_DIR)
    vi.stubEnv('HOME', isolated)
    setPodNativePeerUnpackagedApp(false)
    expect(podNativePeerRequirement()).toBe(POD_UI_PEER_REQUIREMENT)
  })
})

describe('podNativePeerCheck without product identity', () => {
  const verifier = vi.fn(() => ({ ok: true, pid: 4242 }))

  it('checks peers in an E2E run of an unpackaged app', () => {
    vi.stubEnv('ORCA_E2E_USER_DATA_DIR', E2E_ENV.ORCA_E2E_USER_DATA_DIR)
    vi.stubEnv('HOME', isolated)
    setPodNativePeerUnpackagedApp(true)
    setPodNativePeerVerifierLoader(() => verifier)

    expect(podNativePeerCheck(new Socket())?.()).toEqual({ ok: true, pid: 4242 })
  })

  it('keeps the shipped rule in the user’s own profile and in a packaged app', () => {
    vi.stubEnv('ORCA_E2E_USER_DATA_DIR', E2E_ENV.ORCA_E2E_USER_DATA_DIR)
    setPodNativePeerVerifierLoader(() => verifier)

    vi.stubEnv('HOME', userInfo().homedir)
    setPodNativePeerUnpackagedApp(true)
    expect(podNativePeerCheck(new Socket())).toBeNull()

    vi.stubEnv('HOME', isolated)
    setPodNativePeerUnpackagedApp(false)
    expect(podNativePeerCheck(new Socket())).toBeNull()
  })
})
