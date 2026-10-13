import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as fsModule from 'node:fs'

const { sessionFromPartitionMock, dialogShowOpenDialogMock } = vi.hoisted(() => ({
  sessionFromPartitionMock: vi.fn(),
  dialogShowOpenDialogMock: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  dialog: { showOpenDialog: dialogShowOpenDialogMock },
  session: { fromPartition: sessionFromPartitionMock }
}))

function slashPath(pathValue: string): string {
  return pathValue.replaceAll('\\', '/')
}

// Fork-only (Pod): Brave is the browser Pod's users import from most. Its macOS data dir, profile
// discovery and Keychain names are pinned here, without any real Brave profile or Keychain.
describe('detectInstalledBrowsers — Brave', () => {
  const originalPlatform = process.platform
  const originalHome = process.env.HOME

  beforeEach(() => {
    // Why: browser-cookie-import.ts binds its named 'node:fs' imports at load time, so each
    // doMock needs a fresh module graph.
    vi.resetModules()
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    process.env.HOME = '/Users/test'
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    process.env.HOME = originalHome
    vi.restoreAllMocks()
  })

  function mockBraveProfiles(
    infoCache: Record<string, { name: string }>,
    cookieDirs: string[]
  ): void {
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof fsModule>('node:fs')
      return {
        ...actual,
        existsSync: (p: string) => {
          const normalizedPath = slashPath(p)
          if (normalizedPath.endsWith('BraveSoftware/Brave-Browser/Local State')) {
            return true
          }
          return cookieDirs.some((dir) =>
            normalizedPath.endsWith(`BraveSoftware/Brave-Browser/${dir}/Network/Cookies`)
          )
        },
        readFileSync: (p: string, enc?: string) => {
          if (
            typeof p === 'string' &&
            slashPath(p).endsWith('BraveSoftware/Brave-Browser/Local State')
          ) {
            return JSON.stringify({ profile: { info_cache: infoCache } })
          }
          return actual.readFileSync(p as never, enc as never)
        }
      }
    })
  }

  it("finds Brave under BraveSoftware/Brave-Browser with Brave's own Keychain item", async () => {
    mockBraveProfiles({ Default: { name: 'Personal' } }, ['Default'])

    const { detectInstalledBrowsers } = await import('./browser-cookie-import')
    const brave = detectInstalledBrowsers().find((b) => b.label === 'Brave')
    expect(brave).toBeDefined()
    // Why 'chromium': Brave's family id predates the per-browser ids; the import RPC takes it.
    expect(brave?.family).toBe('chromium')
    expect(slashPath(brave?.cookiesPath ?? '')).toBe(
      '/Users/test/Library/Application Support/BraveSoftware/Brave-Browser/Default/Network/Cookies'
    )
    expect(brave?.keychainService).toBe('Brave Safe Storage')
    expect(brave?.keychainAccount).toBe('Brave')
    expect(brave?.profiles).toEqual([{ name: 'Personal', directory: 'Default' }])
  })

  it('lists every Brave profile and selects the first one with cookies', async () => {
    mockBraveProfiles({ Default: { name: 'Personal' }, 'Profile 2': { name: 'Work' } }, [
      'Profile 2'
    ])

    const { detectInstalledBrowsers } = await import('./browser-cookie-import')
    const brave = detectInstalledBrowsers().find((b) => b.label === 'Brave')
    expect(brave?.profiles.map((p) => p.directory).sort()).toEqual(['Default', 'Profile 2'])
    expect(brave?.selectedProfile).toBe('Profile 2')
    expect(slashPath(brave?.cookiesPath ?? '')).toContain('Brave-Browser/Profile 2/Network/Cookies')
  })

  it('does not list Brave when its data directory is absent', async () => {
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof fsModule>('node:fs')
      return { ...actual, existsSync: () => false }
    })

    const { detectInstalledBrowsers } = await import('./browser-cookie-import')
    expect(detectInstalledBrowsers().find((b) => b.label === 'Brave')).toBeUndefined()
  })
})
