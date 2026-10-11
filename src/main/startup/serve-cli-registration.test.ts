import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  install: vi.fn(async () => ({ state: 'installed', commandPath: '/usr/local/bin/podx' })),
  dispatcher: vi.fn(async () => ({ state: 'installed', dispatcherPath: '/x', target: null })),
  allowsCliAutoInstall: vi.fn(() => true)
}))

vi.mock('electron', () => ({ app: { isPackaged: true } }))
vi.mock('../cli/cli-installer', () => ({
  CliInstaller: class {
    install = mocks.install
  }
}))
vi.mock('../cli/linux-bare-orca-dispatcher', () => ({
  installLinuxBareOrcaDispatcher: mocks.dispatcher
}))
vi.mock('../product-identity/product-identity', () => ({
  allowsCliAutoInstall: mocks.allowsCliAutoInstall
}))

const { registerServeCli } = await import('./serve-cli-registration')

const originalPlatform = process.platform

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
  vi.clearAllMocks()
})

describe('serve CLI registration', () => {
  it('registers nothing in a product build: the CLI comes only from Settings', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    mocks.allowsCliAutoInstall.mockReturnValueOnce(false)
    await registerServeCli()
    expect(mocks.install).not.toHaveBeenCalled()
    expect(mocks.dispatcher).not.toHaveBeenCalled()
  })

  it("keeps upstream's serve registration on macOS", async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    await registerServeCli()
    expect(mocks.install).toHaveBeenCalledOnce()
    expect(mocks.dispatcher).not.toHaveBeenCalled()
  })
})
