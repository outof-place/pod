import type { BrowserWindow } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadUpdaterModule, warmUpdaterModule } from './updater-test-module-loader'

const { autoUpdaterMock, powerMonitorOnMock, fetchNudgeMock, moduleFactories, resetUpdaterMocks } =
  await vi.hoisted(async () => (await import('./updater-test-harness')).createUpdaterMocks())

const optOut = vi.hoisted(() => ({ disabled: true }))
type ProductFeedIdentity = { updateFeed: { provider: 'github'; owner: string; repo: string } }
const product = vi.hoisted(() => {
  const state: { identity: ProductFeedIdentity | null } = { identity: null }
  return state
})

vi.mock('electron', () => moduleFactories.electron())
vi.mock('electron-updater', () => moduleFactories.electronUpdater())
vi.mock('./electron-updater-loader', () => moduleFactories.electronUpdaterLoader())
vi.mock('@electron-toolkit/utils', () => moduleFactories.electronToolkitUtils())
vi.mock('./ipc/pty', () => moduleFactories.ipcPty())
vi.mock('./linux-update-package-type', () => moduleFactories.linuxUpdatePackageType())
vi.mock('./updater-lifecycle-diagnostics', () => moduleFactories.updaterLifecycleDiagnostics())
vi.mock('./updater-changelog', () => moduleFactories.updaterChangelog())
vi.mock('./updater-nudge', () => moduleFactories.updaterNudge())
vi.mock('./update-install-exit-watchdog', () => moduleFactories.updateInstallExitWatchdog())
vi.mock('./updater-prerelease-feed', () => moduleFactories.updaterPrereleaseFeed())
vi.mock('./local-builds/local-build-switch', () => moduleFactories.localBuildSwitch())
vi.mock('./local-builds/local-build-feed-server', () => moduleFactories.localBuildFeedServer())
vi.mock('./updater/official-update-opt-out', () => ({
  OFFICIAL_UPDATES_MANIFEST_FIELD: 'orcaOfficialUpdates',
  isOfficialUpdateFeedDisabled: () => optOut.disabled
}))

vi.mock('./product-identity/product-identity', () => ({
  getProductIdentity: () => product.identity
}))

warmUpdaterModule()

function mainWindowFixture(send = vi.fn()): BrowserWindow {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The updater reads only webContents.send from this window fixture.
  return { webContents: { send } } as never
}

describe('updater with orcaOfficialUpdates=false', () => {
  beforeEach(() => {
    resetUpdaterMocks()
    optOut.disabled = true
    product.identity = null
    vi.useFakeTimers()
  })

  it('never configures the official feed or schedules checks', async () => {
    const { setupAutoUpdater } = await loadUpdaterModule()

    setupAutoUpdater(mainWindowFixture(), { getLastUpdateCheckAt: () => null })
    await vi.advanceTimersByTimeAsync(48 * 60 * 60 * 1000)

    expect(autoUpdaterMock.setFeedURL).not.toHaveBeenCalled()
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
    expect(fetchNudgeMock).not.toHaveBeenCalled()
    expect(powerMonitorOnMock).not.toHaveBeenCalled()
  })

  it('answers manual and background checks with not-available instead of checking', async () => {
    const sendMock = vi.fn()
    const { setupAutoUpdater, checkForUpdates, checkForUpdatesFromMenu } = await loadUpdaterModule()

    setupAutoUpdater(mainWindowFixture(sendMock))
    checkForUpdatesFromMenu()
    checkForUpdates()
    await vi.advanceTimersByTimeAsync(0)

    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
    expect(sendMock).toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({ state: 'not-available', userInitiated: true })
    )
  })

  it('keeps checking the official feed when the flag is absent', async () => {
    optOut.disabled = false
    const { setupAutoUpdater } = await loadUpdaterModule()

    setupAutoUpdater(mainWindowFixture(), { getLastUpdateCheckAt: () => null })

    expect(autoUpdaterMock.setFeedURL).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
  })

  it('updates a downstream product from its own GitHub releases, never the official feed', async () => {
    product.identity = { updateFeed: { provider: 'github', owner: 'outof-place', repo: 'pod' } }
    const { setupAutoUpdater } = await loadUpdaterModule()

    setupAutoUpdater(mainWindowFixture(), { getLastUpdateCheckAt: () => null })
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })

    expect(autoUpdaterMock.setFeedURL.mock.calls).toEqual([
      [{ provider: 'github', owner: 'outof-place', repo: 'pod' }]
    ])
    expect(fetchNudgeMock).not.toHaveBeenCalled()
  })

  it('checks the product feed from the menu without pinning an official tag', async () => {
    product.identity = { updateFeed: { provider: 'github', owner: 'outof-place', repo: 'pod' } }
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()

    setupAutoUpdater(mainWindowFixture(), { getLastUpdateCheckAt: () => Date.now() })
    checkForUpdatesFromMenu()
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })

    expect(autoUpdaterMock.setFeedURL).toHaveBeenCalledTimes(1)
    expect(autoUpdaterMock.setFeedURL).toHaveBeenCalledWith({
      provider: 'github',
      owner: 'outof-place',
      repo: 'pod'
    })
  })
})
