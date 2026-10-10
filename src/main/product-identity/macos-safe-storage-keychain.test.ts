import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMacSafeStorageKeychain } from './macos-safe-storage-keychain'

const SECRET = 'c2FsdHlzYWx0eXNhbHR5c2FsdA=='

// Real `/usr/bin/security` against a scratch keychain: items created by `security` itself trust it,
// so nothing prompts, and the login keychain is never touched.
// Opt-in (POD_REAL_KEYCHAIN_TEST=1) because create-keychain and delete-keychain mutate the user's
// keychain search list: run it only on CI or as a throwaway user, never on a developer's own login.
describe.skipIf(process.platform !== 'darwin' || process.env.POD_REAL_KEYCHAIN_TEST !== '1')(
  'createMacSafeStorageKeychain',
  () => {
    let dir: string
    let keychainPath: string

    beforeAll(() => {
      dir = realpathSync(mkdtempSync(join(tmpdir(), 'pod-keychain-')))
      keychainPath = join(dir, 'scratch.keychain-db')
      execFileSync('/usr/bin/security', ['create-keychain', '-p', 'scratch', keychainPath])
      execFileSync('/usr/bin/security', ['unlock-keychain', '-p', 'scratch', keychainPath])
      execFileSync('/usr/bin/security', [
        'add-generic-password',
        '-s',
        'orca Safe Storage',
        '-a',
        'orca Key',
        '-w',
        SECRET,
        keychainPath
      ])
    })

    afterAll(() => {
      try {
        execFileSync('/usr/bin/security', ['delete-keychain', keychainPath])
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('reads the legacy item and writes the product item without exposing the secret in argv', () => {
      const keychain = createMacSafeStorageKeychain(keychainPath)

      expect(keychain.hasItem('orca Safe Storage', 'orca Key')).toBe(true)
      expect(keychain.hasItem('pod Safe Storage', 'pod Key')).toBe(false)
      expect(keychain.readSecret('orca Safe Storage', 'orca Key')).toBe(SECRET)

      keychain.writeSecret('pod Safe Storage', 'pod Key', SECRET, null)

      expect(keychain.hasItem('pod Safe Storage', 'pod Key')).toBe(true)
      expect(keychain.readSecret('pod Safe Storage', 'pod Key')).toBe(SECRET)
    })

    it('reports a missing item as null', () => {
      expect(createMacSafeStorageKeychain(keychainPath).readSecret('nope', 'nope')).toBeNull()
    })

    it('refuses names that would break the security -i command line', () => {
      expect(() =>
        createMacSafeStorageKeychain(keychainPath).writeSecret('bad"name', 'a', SECRET, null)
      ).toThrow(/must not contain/)
    })
  }
)
