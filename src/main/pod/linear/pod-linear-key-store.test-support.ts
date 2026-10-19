// Fork-only (Pod): a fake keychain and userData for the Linear store's tests. No test touches the
// real keychain or the user's profile.
import { setAppEnvironment } from '../../../shared/app-environment'
import type { SecretStore } from '../../../shared/secret-store'

export function fakeKeychain(overrides: Partial<SecretStore> = {}): SecretStore {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`sealed:${Buffer.from(value).toString('base64')}`),
    decryptString: (cipher) => {
      const text = cipher.toString('utf-8')
      if (!text.startsWith('sealed:')) {
        throw new Error('not sealed')
      }
      return Buffer.from(text.slice('sealed:'.length), 'base64').toString('utf-8')
    },
    describeProtectionGap: () => null,
    ...overrides
  }
}

export function setTestUserData(userData: string): void {
  setAppEnvironment({
    getPath: () => userData,
    getAppPath: () => userData,
    getVersion: () => 'test',
    isPackaged: () => false,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  })
}
