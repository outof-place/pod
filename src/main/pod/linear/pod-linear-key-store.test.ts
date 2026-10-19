// Fork-only (Pod): the Linear key is sealed, atomic and 0600 in an 0700 directory, or not stored at all.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { setSecretStore, type SecretStore } from '../../../shared/secret-store'
import { CredentialDecryptionError } from '../../integration-credential-file'
import {
  ensurePodLinearDir,
  podLinearStoreDir,
  POD_LINEAR_UNSEALED_MESSAGE,
  readPodLinearKey,
  writePodLinearKey
} from './pod-linear-key-store'
import { fakeKeychain, setTestUserData } from './pod-linear-key-store.test-support'

const KEY = 'mock-linear-key-1'

function modeOf(path: string): number {
  return statSync(path).mode & 0o777
}

let userData = ''

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'pod-linear-key-store-'))
  setTestUserData(userData)
  setSecretStore(fakeKeychain())
})

describe('Pod Linear key store', () => {
  it('lives in userData/integrations/linear, owner-only, tightening a looser directory', () => {
    const dir = podLinearStoreDir()
    expect(dir).toBe(join(userData, 'integrations', 'linear'))
    mkdirSync(dir, { recursive: true, mode: 0o755 })

    ensurePodLinearDir(dir)

    expect(modeOf(dir)).toBe(0o700)
  })

  it('writes the sealed key with 0600 and no temp file left', () => {
    const dir = podLinearStoreDir()
    ensurePodLinearDir(dir)
    const path = join(dir, 'key.enc')

    writePodLinearKey(path, KEY)

    expect(readFileSync(path).includes(KEY)).toBe(false)
    expect(readPodLinearKey(readFileSync(path))).toBe(KEY)
    expect(modeOf(path)).toBe(0o600)
    expect(readdirSync(dir)).toEqual(['key.enc'])
  })

  it.each([
    ['the keychain is unavailable', { isEncryptionAvailable: () => false }],
    ['the backend seals with a built-in key', { describeProtectionGap: () => 'obfuscated only' }]
  ])('stores nothing when %s', (_why, overrides: Partial<SecretStore>) => {
    setSecretStore(fakeKeychain(overrides))
    const dir = podLinearStoreDir()
    ensurePodLinearDir(dir)
    const path = join(dir, 'key.enc')

    expect(() => writePodLinearKey(path, KEY)).toThrow(POD_LINEAR_UNSEALED_MESSAGE)
    expect(existsSync(path)).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  })

  it('reads an empty file as no key', () => {
    expect(readPodLinearKey(Buffer.alloc(0))).toBeNull()
  })

  it('never reads a stored key as plain text', () => {
    expect(() => readPodLinearKey(Buffer.from(KEY))).toThrow(CredentialDecryptionError)
    setSecretStore(fakeKeychain({ isEncryptionAvailable: () => false }))
    expect(() => readPodLinearKey(Buffer.from(KEY))).toThrow(CredentialDecryptionError)
  })
})
