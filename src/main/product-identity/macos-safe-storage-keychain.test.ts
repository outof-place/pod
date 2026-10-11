import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMacSafeStorageKeychain } from './macos-safe-storage-keychain'

const SECRET = 'c2FsdHlzYWx0eXNhbHR5c2FsdA=='
const SECURITY = '/usr/bin/security'

/** The quoted keychain paths `security default-keychain` / `list-keychains` print. */
function keychainPaths(output: string): string[] {
  return [...output.matchAll(/"([^"]+)"/g)].map((match) => match[1])
}

// Real `/usr/bin/security` against a scratch keychain: items created by `security` itself trust it,
// so nothing prompts, and the login keychain is never touched.
// Opt-in (POD_REAL_KEYCHAIN_TEST=1) because create-keychain and delete-keychain mutate the user's
// keychain search list: run it only on CI or as a throwaway user, never on a developer's own login.
describe.skipIf(process.platform !== 'darwin' || process.env.POD_REAL_KEYCHAIN_TEST !== '1')(
  'createMacSafeStorageKeychain',
  () => {
    let dir: string
    let keychainPath: string
    // Why: create-keychain and delete-keychain change the user's default keychain and search list.
    let defaultKeychain: string[] = []
    let searchList: string[] = []

    beforeAll(() => {
      defaultKeychain = keychainPaths(
        execFileSync(SECURITY, ['default-keychain', '-d', 'user'], { encoding: 'utf8' })
      )
      searchList = keychainPaths(
        execFileSync(SECURITY, ['list-keychains', '-d', 'user'], { encoding: 'utf8' })
      )
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
        execFileSync(SECURITY, ['delete-keychain', keychainPath])
      } finally {
        rmSync(dir, { recursive: true, force: true })
        // An empty list would clear the search list: restore only what was read.
        if (searchList.length > 0) {
          execFileSync(SECURITY, ['list-keychains', '-d', 'user', '-s', ...searchList])
        }
        if (defaultKeychain.length === 1) {
          execFileSync(SECURITY, ['default-keychain', '-d', 'user', '-s', defaultKeychain[0]])
        }
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
