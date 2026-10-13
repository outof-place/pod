import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CookiesGetFilter } from 'electron'

const {
  appGetPathMock,
  runProcessSyncMock,
  sessionFromPartitionMock,
  dialogShowOpenDialogMock,
  setPendingCookieImportMock,
  clearPendingCookieImportMock,
  writeCookieIdentityMock
} = vi.hoisted(() => ({
  appGetPathMock: vi.fn(),
  runProcessSyncMock: vi.fn(),
  sessionFromPartitionMock: vi.fn(),
  dialogShowOpenDialogMock: vi.fn(),
  setPendingCookieImportMock: vi.fn(),
  clearPendingCookieImportMock: vi.fn(),
  writeCookieIdentityMock: vi.fn()
}))

vi.mock('./browser-session-registry', () => ({
  browserSessionRegistry: {
    setPendingCookieImport: setPendingCookieImportMock,
    clearPendingCookieImport: clearPendingCookieImportMock
  }
}))
// Why: the key lookup must never reach the real `security` CLI or the user's Keychain.
vi.mock('@orca/process-host', () => ({
  runProcessSync: runProcessSyncMock
}))
vi.mock('electron', () => ({
  app: { getPath: appGetPathMock },
  BrowserWindow: { fromWebContents: vi.fn() },
  dialog: { showOpenDialog: dialogShowOpenDialogMock },
  session: { fromPartition: sessionFromPartitionMock }
}))
vi.mock('./browser-cookie-clear-store', () => ({
  openCookieClearStore: (targetSession: {
    cookies: {
      get: (filter: CookiesGetFilter) => Promise<unknown>
      remove: (url: string, name: string) => Promise<void>
    }
  }) => ({
    get: (filter: CookiesGetFilter) => targetSession.cookies.get(filter),
    remove: (url: string, name: string) => targetSession.cookies.remove(url, name),
    snapshotClearIdentities: async (items: { cookie: Record<string, unknown>; url: string }[]) =>
      items.map(({ cookie, url }) => ({ url, ...cookie })),
    restoreClearIdentities: async () => undefined,
    // Why (STA-4300): imports write through the CDP identity store, not cookies.set.
    writeCookieIdentity: writeCookieIdentityMock,
    dispose: () => undefined
  })
}))

import { importCookiesFromBrowser, type DetectedBrowser } from './browser-cookie-import'
import {
  createChromiumCookieTestDatabase,
  encryptMacChromiumCookie
} from './browser-cookie-import-test-database'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

function braveBrowser(cookiesPath: string): DetectedBrowser {
  return {
    family: 'chromium',
    label: 'Brave',
    cookiesPath,
    keychainService: 'Brave Safe Storage',
    keychainAccount: 'Brave',
    profiles: [{ name: 'Personal', directory: 'Default' }],
    selectedProfile: 'Default'
  }
}

// Why (STA-4300): cookies.set() drops partitionKey, so only the __init probe may reach it.
const unreachableCookieSet = vi.fn(async (details: { name: string }) => {
  if (details.name !== '__init') {
    throw new Error(`cookies.set was called for user cookie ${details.name}`)
  }
})

// Fork-only (Pod): pins Brave's v10 decryption to Brave's own Keychain item, with a mocked key.
describe('importCookiesFromBrowser — Brave', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orca-brave-cookie-test-'))
    writeCookieIdentityMock.mockReset()
    writeCookieIdentityMock.mockResolvedValue(undefined)
    appGetPathMock.mockReset()
    appGetPathMock.mockReturnValue(join(tmpDir, 'userData'))
    setPendingCookieImportMock.mockClear()
    clearPendingCookieImportMock.mockClear()
    runProcessSyncMock.mockReset()
    sessionFromPartitionMock.mockReset()
    sessionFromPartitionMock.mockReturnValue({
      cookies: {
        get: vi.fn().mockResolvedValue([]),
        set: unreachableCookieSet,
        remove: vi.fn().mockResolvedValue(undefined),
        flushStore: vi.fn().mockResolvedValue(undefined)
      },
      clearData: vi.fn().mockResolvedValue(undefined),
      setUserAgent: vi.fn(),
      getStoragePath: () => join(tmpDir, 'userData', 'Partitions', 'test')
    })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("decrypts Brave's v10 rows with the Brave Safe Storage key", async () => {
    const password = 'brave-test-password'
    const sourceCookiesPath = join(
      tmpDir,
      'BraveSoftware',
      'Brave-Browser',
      'Default',
      'Network',
      'Cookies'
    )
    const targetCookiesPath = join(tmpDir, 'userData', 'Partitions', 'test', 'Network', 'Cookies')
    createChromiumCookieTestDatabase(sourceCookiesPath, [
      {
        domain: '.brave-example.com',
        name: 'sid',
        value: '',
        encryptedValue: encryptMacChromiumCookie('brave-value', password)
      }
    ]).close()
    createChromiumCookieTestDatabase(targetCookiesPath, []).close()
    runProcessSyncMock.mockReturnValue({
      code: 0,
      signal: null,
      stdout: `${password}\n`,
      stderr: '',
      timedOut: false
    })
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')

    try {
      const result = await importCookiesFromBrowser(braveBrowser(sourceCookiesPath), 'persist:test')

      expect(result.ok).toBe(true)
      expect(runProcessSyncMock).toHaveBeenCalledTimes(1)
      expect(runProcessSyncMock).toHaveBeenCalledWith({
        program: 'security',
        args: ['find-generic-password', '-s', 'Brave Safe Storage', '-a', 'Brave', '-w'],
        timeoutMs: 30_000
      })
      expect(writeCookieIdentityMock).toHaveBeenCalledWith(
        expect.objectContaining({ domain: '.brave-example.com', name: 'sid', value: 'brave-value' })
      )
    } finally {
      platformSpy.mockRestore()
    }
  })
})
