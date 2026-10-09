import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ProductIdentityModule from '../product-identity/product-identity'
import type { ProductIdentity } from '../product-identity/product-identity'
import { podIdentityWithoutStablyServices } from '../product-identity/product-identity.test-fixture'
import {
  createHarness,
  createIpcHandlerLookup,
  createWindow,
  flushAsyncWork,
  resetStarNagMocks,
  type TestWindow
} from './service-test-harness'

const mocks = vi.hoisted(() => {
  const identity: { current: ProductIdentity | null } = { current: null }
  return {
    appMock: { getVersion: vi.fn(() => '1.2.3') },
    browserWindowMock: { getAllWindows: vi.fn<() => TestWindow[]>(() => []) },
    checkOrcaStarredMock: vi.fn(),
    starOrcaMock: vi.fn(),
    trackMock: vi.fn(),
    getCohortAtEmitMock: vi.fn(() => ({ nth_repo_added: 3 })),
    ipcMainHandleMock: vi.fn(),
    identity
  }
})

vi.mock('electron', () => ({
  app: mocks.appMock,
  BrowserWindow: mocks.browserWindowMock,
  ipcMain: { handle: mocks.ipcMainHandleMock }
}))
vi.mock('../github/client', () => ({
  checkOrcaStarred: mocks.checkOrcaStarredMock,
  starOrca: mocks.starOrcaMock
}))
vi.mock('../telemetry/client', () => ({ track: mocks.trackMock }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: mocks.getCohortAtEmitMock }))
vi.mock('../product-identity/product-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof ProductIdentityModule>()),
  getProductIdentity: () => mocks.identity.current
}))

const getIpcHandler = createIpcHandlerLookup(mocks.ipcMainHandleMock)

describe('star prompts without Stably services', () => {
  beforeEach(() => {
    resetStarNagMocks(mocks)
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    mocks.identity.current = podIdentityWithoutStablyServices()
  })

  afterEach(() => {
    mocks.identity.current = null
    vi.restoreAllMocks()
  })

  it('prompts at the spawn threshold for upstream Orca', async () => {
    mocks.identity.current = null
    const window = createWindow()
    mocks.browserWindowMock.getAllWindows.mockReturnValue([window])
    const { service, emitAgentStarted } = createHarness()

    service.start()
    emitAgentStarted(45)
    await flushAsyncWork()

    expect(window.webContents.send).toHaveBeenCalledWith('star-nag:show', expect.anything())
  })

  it('never watches agent spawns or shows a prompt, even when forced', async () => {
    const window = createWindow()
    mocks.browserWindowMock.getAllWindows.mockReturnValue([window])
    const { service, emitAgentStarted } = createHarness()

    service.start()
    service.registerIpcHandlers()
    emitAgentStarted(45)
    await getIpcHandler('star-nag:forceShow')()
    await flushAsyncWork()

    expect(window.webContents.send).not.toHaveBeenCalled()
  })
})
