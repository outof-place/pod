// Fork-only (Pod): only an E2E run (isolated profile and HOME) admits PodNative's measure build and
// checks peers without product identity; the user's own profile keeps the shipped rule.
import { Socket } from 'node:net'
import { userInfo } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as ProductIdentityModule from '../../product-identity/product-identity'
import { POD_UI_PEER_REQUIREMENT } from '../ui-host/pod-peer-identity'
import {
  isPodNativePeerE2ERun,
  POD_NATIVE_PEER_E2E_REQUIREMENT,
  podNativePeerCheck,
  podNativePeerRequirement,
  setPodNativePeerVerifierLoader
} from './pod-native-peer'

vi.mock('../../product-identity/product-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof ProductIdentityModule>()),
  getProductIdentity: () => null
}))

const ACCOUNT_HOME = '/Users/ada'
const E2E_ENV = { ORCA_E2E_USER_DATA_DIR: '/private/tmp/pod-e2e/profile' }

afterEach(() => {
  setPodNativePeerVerifierLoader(null)
  vi.unstubAllEnvs()
})

describe('isPodNativePeerE2ERun', () => {
  it('needs both the isolated profile and a HOME that is not the account’s', () => {
    expect(isPodNativePeerE2ERun(E2E_ENV, '/private/tmp/pod-e2e/home', ACCOUNT_HOME)).toBe(true)
    expect(isPodNativePeerE2ERun(E2E_ENV, ACCOUNT_HOME, ACCOUNT_HOME)).toBe(false)
    expect(isPodNativePeerE2ERun(E2E_ENV, `${ACCOUNT_HOME}/`, ACCOUNT_HOME)).toBe(false)
    expect(isPodNativePeerE2ERun({}, '/private/tmp/pod-e2e/home', ACCOUNT_HOME)).toBe(false)
    expect(isPodNativePeerE2ERun(E2E_ENV, '/private/tmp/pod-e2e/home', null)).toBe(false)
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
})

describe('podNativePeerCheck without product identity', () => {
  // An unconnected socket: the verifier answers for it.
  const verifier = vi.fn(() => ({ ok: true, pid: 4242 }))

  it('checks peers in an E2E run', () => {
    vi.stubEnv('ORCA_E2E_USER_DATA_DIR', E2E_ENV.ORCA_E2E_USER_DATA_DIR)
    vi.stubEnv('HOME', '/private/tmp/pod-e2e/home')
    setPodNativePeerVerifierLoader(() => verifier)

    const check = podNativePeerCheck(new Socket())

    expect(check?.()).toEqual({ ok: true, pid: 4242 })
  })

  it('keeps the shipped rule in the user’s own profile: no check, so no PodNative', () => {
    vi.stubEnv('ORCA_E2E_USER_DATA_DIR', E2E_ENV.ORCA_E2E_USER_DATA_DIR)
    vi.stubEnv('HOME', userInfo().homedir)
    setPodNativePeerVerifierLoader(() => verifier)

    expect(podNativePeerCheck(new Socket())).toBeNull()
  })
})
