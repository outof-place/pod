// Fork-only (Pod): Pod's own Linear store, <userData>/integrations/linear/. Orca.app keeps its keys in
// ~/.orca; Pod never reads, writes or deletes those, so a user enters the key again in Pod. A key is
// sealed by the OS keychain or not stored at all: there is no plain-text fallback either way.
import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getAppEnvironment } from '../../../shared/app-environment'
import { getSecretStore } from '../../../shared/secret-store'
import {
  CredentialDecryptionError,
  writeCredentialFileAtomic
} from '../../integration-credential-file'

export const POD_LINEAR_UNSEALED_MESSAGE =
  'Pod stores a Linear key only when the system keychain can seal it, and it cannot here. Nothing was saved.'

export function podLinearStoreDir(): string {
  return join(getAppEnvironment().getPath('userData'), 'integrations', 'linear')
}

/** Creates the directory owner-only, and tightens one that already exists. */
export function ensurePodLinearDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    chmodSync(dir, 0o700)
  } catch {
    // Best-effort, as for credential files: Windows has no POSIX modes.
  }
}

/**
 * Whether anyone could forge what this process seals: a backend with a protection gap (a built-in
 * key), or the test keychain (`--use-mock-keychain`), which seals with a fixed password. Harmless
 * for an API key, which a forger would have to know anyway; not for a switch like agent access.
 */
export function isPodLinearSealForgeable(argv: readonly string[] = process.argv): boolean {
  return argv.includes('--use-mock-keychain') || getSecretStore().describeProtectionGap() !== null
}

/** Seals the key and writes it atomically with 0600; throws, writing nothing, if it can't seal. */
export function writePodLinearKey(path: string, apiKey: string): void {
  const store = getSecretStore()
  // Why the gap too: a backend that "seals" with a built-in key protects nothing.
  if (!store.isEncryptionAvailable() || store.describeProtectionGap() !== null) {
    throw new Error(POD_LINEAR_UNSEALED_MESSAGE)
  }
  writeCredentialFileAtomic(path, store.encryptString(apiKey))
}

/** The stored key, or null for an empty file. Bytes Pod can't unseal are an error, never plain text. */
export function readPodLinearKey(raw: Buffer): string | null {
  if (raw.length === 0) {
    return null
  }
  const store = getSecretStore()
  if (!store.isEncryptionAvailable()) {
    throw new CredentialDecryptionError('Linear')
  }
  let key: string
  try {
    key = store.decryptString(raw)
  } catch {
    throw new CredentialDecryptionError('Linear')
  }
  return key.length > 0 ? key : null
}
