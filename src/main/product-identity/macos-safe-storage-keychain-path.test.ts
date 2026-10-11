import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// A stubbed `security`: these tests never run the real one (it acts on login.keychain-db when
// handed a keychain path that doesn't exist).
type Result = { code: number; stdout: string; stderr: string; timedOut: boolean }
const ok = (code = 0): Result => ({ code, stdout: '', stderr: '', timedOut: false })
const runProcessSync = vi.hoisted(() => vi.fn((): Result => ok()))
vi.mock('../../shared/child-process/run-process', () => ({ runProcessSync }))

const { createMacSafeStorageKeychain } = await import('./macos-safe-storage-keychain')

let dir: string | null = null

function scratchKeychain(): string {
  dir = mkdtempSync(join(tmpdir(), 'pod-keychain-path-'))
  const keychainPath = join(dir, 'scratch.keychain-db')
  writeFileSync(keychainPath, '')
  return keychainPath
}

afterEach(() => {
  runProcessSync.mockReset()
  runProcessSync.mockImplementation(() => ok())
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
    expect(() => keychain.deleteItem('pod Safe Storage', 'pod Key')).toThrow(/does not exist/)
    expect(runProcessSync).not.toHaveBeenCalled()
  })

  it('passes an existing keychain to security', () => {
    const keychainPath = scratchKeychain()
    expect(createMacSafeStorageKeychain(keychainPath).hasItem('pod Safe Storage', 'pod Key')).toBe(
      true
    )
    expect(runProcessSync).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ['find-generic-password', '-s', 'pod Safe Storage', '-a', 'pod Key', keychainPath]
      })
    )
  })

  it('never deletes without both a service and an account', () => {
    const keychain = createMacSafeStorageKeychain(scratchKeychain())
    expect(() => keychain.deleteItem('', 'pod Key')).toThrow(/both a service and an account/)
    expect(() => keychain.deleteItem('pod Safe Storage', '')).toThrow(/both a service/)
    expect(runProcessSync).not.toHaveBeenCalled()
  })

  it('reports a delete as done only when security succeeded and the item is gone', () => {
    const keychainPath = scratchKeychain()
    const keychain = createMacSafeStorageKeychain(keychainPath)
    // delete-generic-password fails (44: no such item): not done.
    runProcessSync.mockImplementationOnce(() => ok(44))
    expect(keychain.deleteItem('pod Safe Storage', 'pod Key')).toBe(false)
    // delete succeeds, then find-generic-password no longer finds it: done.
    runProcessSync.mockImplementationOnce(() => ok()).mockImplementationOnce(() => ok(44))
    expect(keychain.deleteItem('pod Safe Storage', 'pod Key')).toBe(true)
    expect(runProcessSync).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ['delete-generic-password', '-s', 'pod Safe Storage', '-a', 'pod Key', keychainPath]
      })
    )
  })
})
