import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// A stubbed `security`: these tests never run the real one (it acts on login.keychain-db when
// handed a keychain path that doesn't exist).
const runProcessSync = vi.hoisted(() =>
  vi.fn(() => ({ code: 0, stdout: '', stderr: '', timedOut: false }))
)
vi.mock('@orca/process-host', () => ({ runProcessSync }))

const { createMacSafeStorageKeychain } = await import('./macos-safe-storage-keychain')

let dir: string | null = null

afterEach(() => {
  runProcessSync.mockClear()
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
    dir = null
  }
})

describe('createMacSafeStorageKeychain with a keychain path', () => {
  it('refuses a keychain that does not exist before running security at all', () => {
    const keychain = createMacSafeStorageKeychain('/nonexistent/scratch.keychain-db')
    expect(() => keychain.hasItem('pod Safe Storage', 'pod Key')).toThrow(/does not exist/)
    expect(() => keychain.readSecret('pod Safe Storage', 'pod Key')).toThrow(/does not exist/)
    expect(() => keychain.writeSecret('pod Safe Storage', 'pod Key', 'secret', null)).toThrow(
      /does not exist/
    )
    expect(runProcessSync).not.toHaveBeenCalled()
  })

  it('passes an existing keychain to security', () => {
    dir = mkdtempSync(join(tmpdir(), 'pod-keychain-path-'))
    const keychainPath = join(dir, 'scratch.keychain-db')
    writeFileSync(keychainPath, '')
    expect(createMacSafeStorageKeychain(keychainPath).hasItem('pod Safe Storage', 'pod Key')).toBe(
      true
    )
    expect(runProcessSync).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ['find-generic-password', '-s', 'pod Safe Storage', '-a', 'pod Key', keychainPath]
      })
    )
  })
})
