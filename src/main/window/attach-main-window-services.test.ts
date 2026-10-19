import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import { cancelHistoryGc } from '../terminal-history-gc'
import type { registerSshHandlers } from '../ipc/ssh'
import type { registerRemoteWorkspaceHandlers } from '../ipc/remote-workspace'
import type { registerDaemonManagementHandlers } from '../ipc/pty-management'
import type { registerWorkspaceCleanupHandlers } from '../ipc/workspace-cleanup'
import type { startFolderRepoGitUpgradeWatch } from '../ipc/folder-repo-git-upgrade'
import {
  createMainWindowServiceStub,
  createRuntime,
  deferred,
  type MainWindowStub
} from './main-window-service-stubs.test-fixture'

const {
  onMock,
  removeAllListenersMock,
  removeListenerMock,
  setPermissionRequestHandlerMock,
  setPermissionCheckHandlerMock,
  handleMock,
  removeHandlerMock,
  systemPreferencesAskForMediaAccessMock,
  systemPreferencesGetMediaAccessStatusMock,
  registerRepoHandlersMock,
  setRepoRemoteClientNotifierMock,
  setWorktreeCatalogRemoteClientNotifierMock,
  registerWorktreeHandlersMock,
  registerPtyHandlersMock,
  registerSshHandlersMock,
  registerRemoteWorkspaceHandlersMock,
  registerDaemonManagementHandlersMock,
  registerWorkspaceCleanupHandlersMock,
  startFolderRepoGitUpgradeWatchMock,
  hydrateLocalPtyRegistryAtBootMock,
  setWorktreeBaseDirectoryWatcherSyncContextMock,
  scheduleWorktreeBaseDirectoryWatcherSyncMock,
  setupAutoUpdaterMock,
  browserManagerUnregisterAllMock,
  runWorktreeChangeInvalidatorsMock
} = vi.hoisted(() => ({
  onMock: vi.fn(),
  removeAllListenersMock: vi.fn(),
  removeListenerMock: vi.fn(),
  setPermissionRequestHandlerMock: vi.fn(),
  setPermissionCheckHandlerMock: vi.fn(),
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  systemPreferencesAskForMediaAccessMock: vi.fn(),
  systemPreferencesGetMediaAccessStatusMock: vi.fn(),
  registerRepoHandlersMock: vi.fn(),
  setRepoRemoteClientNotifierMock: vi.fn(),
  setWorktreeCatalogRemoteClientNotifierMock: vi.fn(),
  registerWorktreeHandlersMock: vi.fn(),
  registerPtyHandlersMock: vi.fn(),
  registerSshHandlersMock: vi.fn<(...args: Parameters<typeof registerSshHandlers>) => void>(),
  registerRemoteWorkspaceHandlersMock:
    vi.fn<(...args: Parameters<typeof registerRemoteWorkspaceHandlers>) => void>(),
  registerDaemonManagementHandlersMock: vi.fn<typeof registerDaemonManagementHandlers>(),
  registerWorkspaceCleanupHandlersMock: vi.fn<typeof registerWorkspaceCleanupHandlers>(),
  startFolderRepoGitUpgradeWatchMock: vi.fn<typeof startFolderRepoGitUpgradeWatch>(),
  hydrateLocalPtyRegistryAtBootMock: vi.fn(),
  setWorktreeBaseDirectoryWatcherSyncContextMock: vi.fn(),
  scheduleWorktreeBaseDirectoryWatcherSyncMock: vi.fn(),
  setupAutoUpdaterMock: vi.fn(),
  browserManagerUnregisterAllMock: vi.fn(),
  runWorktreeChangeInvalidatorsMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {},
  clipboard: {},
  systemPreferences: {
    askForMediaAccess: systemPreferencesAskForMediaAccessMock,
    getMediaAccessStatus: systemPreferencesGetMediaAccessStatusMock
  },
  ipcMain: {
    on: onMock,
    removeAllListeners: removeAllListenersMock,
    removeListener: removeListenerMock,
    removeHandler: removeHandlerMock,
    handle: handleMock
  },
  powerMonitor: {
    on: vi.fn(),
    off: vi.fn()
  }
}))

vi.mock('../ipc/repos', () => ({
  registerRepoHandlers: registerRepoHandlersMock
}))

vi.mock('../ipc/repos/repos-changed-notification', () => ({
  setRepoRemoteClientNotifier: setRepoRemoteClientNotifierMock
}))

vi.mock('../ipc/watched-worktree-catalog-notification', () => ({
  setWorktreeCatalogRemoteClientNotifier: setWorktreeCatalogRemoteClientNotifierMock
}))

vi.mock('../ipc/worktrees', () => ({
  registerWorktreeHandlers: registerWorktreeHandlersMock
}))

vi.mock('../ipc/worktree-change-invalidators', () => ({
  runWorktreeChangeInvalidators: runWorktreeChangeInvalidatorsMock
}))

vi.mock('../ipc/pty', () => ({
  getLocalPtyProvider: vi.fn(),
  registerPtyHandlers: registerPtyHandlersMock
}))

vi.mock('../ipc/ssh', () => ({ registerSshHandlers: registerSshHandlersMock }))
vi.mock('../ipc/remote-workspace', () => ({
  registerRemoteWorkspaceHandlers: registerRemoteWorkspaceHandlersMock
}))
vi.mock('../ipc/pty-management', () => ({
  registerDaemonManagementHandlers: registerDaemonManagementHandlersMock
}))
vi.mock('../ipc/workspace-cleanup', () => ({
  registerWorkspaceCleanupHandlers: registerWorkspaceCleanupHandlersMock
}))
vi.mock('../agent-hooks/server', () => ({
  agentHookServer: { getStatusSnapshot: vi.fn(() => []) }
}))
vi.mock('../ipc/folder-repo-git-upgrade', () => ({
  startFolderRepoGitUpgradeWatch: startFolderRepoGitUpgradeWatchMock
}))

vi.mock('../memory/hydrate-local-pty-registry', () => ({
  hydrateLocalPtyRegistryAtBoot: hydrateLocalPtyRegistryAtBootMock
}))

vi.mock('../ipc/worktree-base-directory-watcher', () => ({
  setWorktreeBaseDirectoryWatcherSyncContext: setWorktreeBaseDirectoryWatcherSyncContextMock,
  scheduleWorktreeBaseDirectoryWatcherSync: scheduleWorktreeBaseDirectoryWatcherSyncMock
}))

vi.mock('../browser/browser-manager', () => ({
  browserManager: {
    unregisterAll: browserManagerUnregisterAllMock
  }
}))

vi.mock('../updater', () => ({
  checkForUpdates: vi.fn(),
  getUpdateStatus: vi.fn(),
  quitAndInstall: vi.fn(),
  dismissNudge: vi.fn(),
  setupAutoUpdater: setupAutoUpdaterMock
}))

import { attachMainWindowServices } from './attach-main-window-services'

type MockFn = ReturnType<typeof vi.fn>

function createMainWindow(
  extraWebContents: { isLoadingMainFrame?: MockFn; on?: MockFn; send?: MockFn } = {}
): MainWindowStub {
  return createMainWindowServiceStub(
    {
      setPermissionRequestHandler: setPermissionRequestHandlerMock,
      setPermissionCheckHandler: setPermissionCheckHandlerMock
    },
    extraWebContents
  )
}

function createStore(): Store & { flushPendingAsync: MockFn } {
  return {
    getProfileStorageDirectory: vi.fn(() => '/profile-a'),
    flushPendingAsync: vi.fn(() => Promise.resolve())
  } as unknown as Store & { flushPendingAsync: MockFn }
}

function getClosedHandlers(mainWindowOnMock: MockFn): (() => void)[] {
  return mainWindowOnMock.mock.calls
    .filter(([event]) => event === 'closed')
    .map(([, handler]) => handler as () => void)
}

// Updater setup is deferred to first paint; fire the captured ready-to-show
// handler and flush its setImmediate hop.
async function fireReadyToShow(mainWindow: MainWindowStub): Promise<void> {
  const handler = mainWindow.once.mock.calls.find(([event]) => event === 'ready-to-show')?.[1] as
    | (() => void)
    | undefined
  handler?.()
  await new Promise((resolve) => {
    setImmediate(resolve)
  })
}

describe('attachMainWindowServices', () => {
  afterEach(() => {
    cancelHistoryGc()
  })

  beforeEach(() => {
    vi.resetAllMocks()
    systemPreferencesAskForMediaAccessMock.mockResolvedValue(true)
    systemPreferencesGetMediaAccessStatusMock.mockReturnValue('granted')
  })

  it('gives host-local catalog notifiers the runtime', () => {
    const runtime = createRuntime()
    const mainWindow = createMainWindow()
    const store = createStore()

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Stubs provide the window/runtime methods exercised by attachment.
    attachMainWindowServices(mainWindow as never, store, runtime as never)

    expect(setRepoRemoteClientNotifierMock).toHaveBeenCalledWith(runtime)
    expect(setWorktreeCatalogRemoteClientNotifierMock).toHaveBeenCalledWith(runtime)
    expect(registerSshHandlersMock).toHaveBeenCalledExactlyOnceWith(
      store,
      expect.any(Function),
      runtime
    )
    expect(registerSshHandlersMock.mock.calls[0]?.[1]()).toBe(mainWindow)
    expect(registerRemoteWorkspaceHandlersMock).toHaveBeenCalledExactlyOnceWith(
      store,
      expect.any(Function),
      runtime
    )
    expect(registerRemoteWorkspaceHandlersMock.mock.calls[0]?.[1]()).toBe(mainWindow)
    expect(registerDaemonManagementHandlersMock).toHaveBeenCalledExactlyOnceWith()
    expect(registerDaemonManagementHandlersMock).toHaveBeenCalledAfter(registerPtyHandlersMock)
    expect(registerWorkspaceCleanupHandlersMock).toHaveBeenCalledExactlyOnceWith(store, {
      readAgentStatusSnapshot: expect.any(Function)
    })
    expect(startFolderRepoGitUpgradeWatchMock).toHaveBeenCalledExactlyOnceWith(store, mainWindow)
  })

  it('reloads the app renderer through main and marks expected renderer teardown', async () => {
    const onBeforeRendererReload = vi.fn()
    const mainWindow = createMainWindow()

    attachMainWindowServices(
      mainWindow as never,
      createStore(),
      createRuntime() as never,
      undefined,
      undefined,
      { onBeforeRendererReload }
    )

    expect(removeHandlerMock).toHaveBeenCalledWith('app:reload')
    const reloadHandler = handleMock.mock.calls.find(([channel]) => channel === 'app:reload')?.[1]
    expect(reloadHandler).toBeTypeOf('function')

    await reloadHandler?.({ sender: mainWindow.webContents })

    expect(onBeforeRendererReload).toHaveBeenCalledWith({
      webContentsId: 1,
      ignoreCache: false
    })
    expect(mainWindow.webContents.reload).toHaveBeenCalledTimes(1)
  })

  it('hydrates once after the local PTY provider barrier resolves', async () => {
    const providerStartup = deferred()
    const store = createStore()

    attachMainWindowServices(
      createMainWindow() as never,
      store,
      createRuntime() as never,
      undefined,
      undefined,
      { awaitLocalPtyProviderStartup: () => providerStartup.promise }
    )

    expect(hydrateLocalPtyRegistryAtBootMock).not.toHaveBeenCalled()

    providerStartup.resolve()
    await providerStartup.promise
    await Promise.resolve()

    expect(hydrateLocalPtyRegistryAtBootMock).toHaveBeenCalledExactlyOnceWith(store)
  })

  it('passes injected update quit cleanup to the auto-updater', async () => {
    const onBeforeUpdateQuit = vi.fn()
    const store = createStore()
    const mainWindow = createMainWindow()

    attachMainWindowServices(
      mainWindow as never,
      store,
      createRuntime() as never,
      undefined,
      undefined,
      {
        onBeforeUpdateQuit,
        onBeforeUpdateQuitFailure: 'abort',
        updateInstallMode: 'supervised-headless-serve'
      }
    )

    // Deferred to first paint — must not be configured at attach time.
    expect(setupAutoUpdaterMock).not.toHaveBeenCalled()
    await fireReadyToShow(mainWindow)
    expect(setupAutoUpdaterMock).toHaveBeenCalledTimes(1)
    const [updaterWindow, updaterOptions] = setupAutoUpdaterMock.mock.calls[0]
    expect(updaterWindow).toBe(mainWindow)
    expect(updaterOptions).toMatchObject({
      installMode: 'supervised-headless-serve',
      onBeforeQuitFailure: 'abort'
    })
    await setupAutoUpdaterMock.mock.calls[0][1].onBeforeQuit()

    expect(onBeforeUpdateQuit).toHaveBeenCalledTimes(1)
    expect(store.flushPendingAsync).toHaveBeenCalledTimes(1)
  })

  it('flushes the store before update quit when no cleanup is injected', async () => {
    const store = createStore()
    const mainWindow = createMainWindow()

    attachMainWindowServices(mainWindow as never, store, createRuntime() as never)

    await fireReadyToShow(mainWindow)
    await setupAutoUpdaterMock.mock.calls[0][1].onBeforeQuit()

    expect(store.flushPendingAsync).toHaveBeenCalledTimes(1)
  })

  it('ignores app reload requests from non-main webContents', async () => {
    const onBeforeRendererReload = vi.fn()
    const mainWindow = createMainWindow()

    attachMainWindowServices(
      mainWindow as never,
      createStore(),
      createRuntime() as never,
      undefined,
      undefined,
      { onBeforeRendererReload }
    )

    const reloadHandler = handleMock.mock.calls.find(([channel]) => channel === 'app:reload')?.[1]
    await reloadHandler?.({ sender: { id: 999 } })

    expect(onBeforeRendererReload).not.toHaveBeenCalled()
    expect(mainWindow.webContents.reload).not.toHaveBeenCalled()
  })

  it('ignores app reload requests after the main window is destroyed without rereading webContents', () => {
    const onBeforeRendererReload = vi.fn()
    const mainWindow = createMainWindow()
    const mainWebContents = mainWindow.webContents

    attachMainWindowServices(
      mainWindow as never,
      createStore(),
      createRuntime() as never,
      undefined,
      undefined,
      { onBeforeRendererReload }
    )

    const reloadHandler = handleMock.mock.calls.find(([channel]) => channel === 'app:reload')?.[1]
    mainWindow.isDestroyed?.mockReturnValue(true)
    Object.defineProperty(mainWindow, 'webContents', {
      get: () => {
        throw new Error('webContents should not be read after registration')
      }
    })

    expect(() => reloadHandler?.({ sender: mainWebContents })).not.toThrow()

    expect(onBeforeRendererReload).not.toHaveBeenCalled()
    expect(mainWebContents.reload).not.toHaveBeenCalled()
  })

  it('ignores app reload requests after the main webContents is destroyed', async () => {
    const onBeforeRendererReload = vi.fn()
    const mainWindow = createMainWindow()

    attachMainWindowServices(
      mainWindow as never,
      createStore(),
      createRuntime() as never,
      undefined,
      undefined,
      { onBeforeRendererReload }
    )

    const reloadHandler = handleMock.mock.calls.find(([channel]) => channel === 'app:reload')?.[1]
    mainWindow.webContents.isDestroyed?.mockReturnValue(true)
    await reloadHandler?.({ sender: mainWindow.webContents })

    expect(onBeforeRendererReload).not.toHaveBeenCalled()
    expect(mainWindow.webContents.reload).not.toHaveBeenCalled()
  })

  it('removes the app reload IPC handler when the owning window closes', () => {
    const mainWindowOnMock = vi.fn()
    const mainWindow = createMainWindow()
    mainWindow.on = mainWindowOnMock

    attachMainWindowServices(mainWindow as never, createStore(), createRuntime() as never)

    removeHandlerMock.mockClear()
    const closedHandlers = getClosedHandlers(mainWindowOnMock)
    expect(closedHandlers.length).toBeGreaterThan(0)
    for (const handler of closedHandlers) {
      handler()
    }

    expect(removeHandlerMock).toHaveBeenCalledWith('app:reload')
  })

  it('keeps a newer app reload handler when an older window closes late', () => {
    const oldWindowOnMock = vi.fn()
    const oldWindow = createMainWindow()
    oldWindow.on = oldWindowOnMock
    attachMainWindowServices(oldWindow as never, createStore(), createRuntime() as never)
    const oldClosedHandlers = getClosedHandlers(oldWindowOnMock)

    const newWindowOnMock = vi.fn()
    const newWindow = createMainWindow()
    newWindow.on = newWindowOnMock
    attachMainWindowServices(newWindow as never, createStore(), createRuntime() as never)

    removeHandlerMock.mockClear()
    for (const handler of oldClosedHandlers) {
      handler()
    }

    expect(removeHandlerMock).not.toHaveBeenCalledWith('app:reload')

    for (const handler of getClosedHandlers(newWindowOnMock)) {
      handler()
    }
    expect(removeHandlerMock).toHaveBeenCalledWith('app:reload')
  })

  it('only allows the explicit permission allowlist', async () => {
    attachMainWindowServices(createMainWindow() as never, createStore(), createRuntime() as never)

    expect(setPermissionRequestHandlerMock).toHaveBeenCalledTimes(1)
    const permissionHandler = setPermissionRequestHandlerMock.mock.calls[0][0]
    const callback = vi.fn()

    permissionHandler(null, 'media', callback, { mediaTypes: ['audio'] })
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(true))
    permissionHandler(null, 'fullscreen', callback)
    permissionHandler(null, 'pointerLock', callback)
    permissionHandler(null, 'clipboard-read', callback)

    expect(callback.mock.calls).toEqual([[true], [true], [true], [false]])
  })

  it('requests macOS media access only when the renderer asks for media', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    try {
      attachMainWindowServices(createMainWindow() as never, createStore(), createRuntime() as never)

      expect(systemPreferencesAskForMediaAccessMock).not.toHaveBeenCalled()

      const permissionHandler = setPermissionRequestHandlerMock.mock.calls[0][0]
      const callback = vi.fn()
      permissionHandler(null, 'media', callback, { mediaTypes: ['audio', 'video'] })

      await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(true))
      expect(systemPreferencesAskForMediaAccessMock.mock.calls).toEqual([
        ['microphone'],
        ['camera']
      ])
    } finally {
      Object.defineProperty(process, 'platform', platform ?? { value: process.platform })
    }
  })

  it('clears browser guest registrations when the main window closes', () => {
    const mainWindowOnMock = vi.fn()
    const mainWindow = createMainWindow()
    mainWindow.on = mainWindowOnMock

    attachMainWindowServices(mainWindow as never, createStore(), createRuntime() as never)

    const closedHandler = getClosedHandlers(mainWindowOnMock).at(-1)
    expect(closedHandler).toBeTypeOf('function')
    closedHandler?.()
    expect(browserManagerUnregisterAllMock).toHaveBeenCalledTimes(1)
  })

  it('clears the runtime notifier when the owning window closes', () => {
    const mainWindowOnMock = vi.fn()
    const mainWindow = createMainWindow()
    mainWindow.on = mainWindowOnMock
    const runtime = createRuntime()

    attachMainWindowServices(mainWindow as never, createStore(), runtime as never)

    runtime.setNotifier.mockClear()
    for (const handler of getClosedHandlers(mainWindowOnMock)) {
      handler()
    }

    expect(runtime.markGraphUnavailable).toHaveBeenCalledWith(1)
    expect(runtime.setNotifier).toHaveBeenCalledWith(null)
  })

  it('keeps a newer runtime notifier when an older window closes late', () => {
    const runtime = createRuntime()
    const oldWindowOnMock = vi.fn()
    const oldWindow = createMainWindow()
    oldWindow.on = oldWindowOnMock
    attachMainWindowServices(oldWindow as never, createStore(), runtime as never)
    const oldClosedHandlers = getClosedHandlers(oldWindowOnMock)

    const newWindowOnMock = vi.fn()
    const newWindow = createMainWindow()
    newWindow.on = newWindowOnMock
    attachMainWindowServices(newWindow as never, createStore(), runtime as never)

    runtime.setNotifier.mockClear()
    for (const handler of oldClosedHandlers) {
      handler()
    }

    expect(runtime.setNotifier).not.toHaveBeenCalledWith(null)

    for (const handler of getClosedHandlers(newWindowOnMock)) {
      handler()
    }
    expect(runtime.setNotifier).toHaveBeenCalledWith(null)
  })

  it('forwards runtime notifier events to the renderer', () => {
    const sendMock = vi.fn()
    const webContentsOnMock = vi.fn()
    const mainWindowOnMock = vi.fn()
    const mainWindow = createMainWindow({ on: webContentsOnMock, send: sendMock })
    mainWindow.isDestroyed = vi.fn(() => false)
    mainWindow.on = mainWindowOnMock
    const runtime = createRuntime()

    attachMainWindowServices(mainWindow as never, createStore(), runtime as never)

    expect(runtime.setNotifier).toHaveBeenCalledTimes(1)
    const notifier = runtime.setNotifier.mock.calls[0][0]
    if (!notifier) {
      throw new Error('Missing runtime notifier')
    }

    notifier.worktreesChanged('repo-1')
    notifier.reposChanged()
    notifier.activateWorktree('repo-1', 'wt-1', {
      runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
      envVars: {
        ORCA_ROOT_PATH: '/tmp/repo',
        ORCA_WORKTREE_PATH: '/tmp/worktrees/wt-1'
      }
    })

    expect(sendMock.mock.calls).toEqual([
      ['worktrees:changed', { repoId: 'repo-1' }],
      ['repos:changed'],
      [
        'ui:activateWorktree',
        {
          repoId: 'repo-1',
          worktreeId: 'wt-1',
          setup: {
            runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
            envVars: {
              ORCA_ROOT_PATH: '/tmp/repo',
              ORCA_WORKTREE_PATH: '/tmp/worktrees/wt-1'
            }
          }
        }
      ]
    ])
    expect(runWorktreeChangeInvalidatorsMock).toHaveBeenCalledWith('repo-1')
    expect(runWorktreeChangeInvalidatorsMock.mock.invocationCallOrder[0]).toBeLessThan(
      sendMock.mock.invocationCallOrder[0]
    )
  })

  it('marks renderer process loss as a graph reload failure', () => {
    const mainWindow = createMainWindow()
    const runtime = createRuntime()
    attachMainWindowServices(mainWindow as never, createStore(), runtime as never)

    const handlers = mainWindow.webContents.on.mock.calls
      .filter(([event]) => event === 'render-process-gone')
      .map(([, handler]) => handler as () => void)
    for (const handler of handlers) {
      handler()
    }

    expect(runtime.markGraphReloadFailed).toHaveBeenCalledWith(1, 'renderer-process-gone')
  })

  it('accepts terminal reveal replies only from the main window renderer', async () => {
    const sendMock = vi.fn()
    const mainWindow = createMainWindow({ send: sendMock })
    const runtime = createRuntime()

    attachMainWindowServices(mainWindow as never, createStore(), runtime as never)

    const notifier = runtime.setNotifier.mock.calls[0][0] as {
      revealTerminalSession: (
        worktreeId: string,
        opts: {
          ptyId: string
          title?: string
          cwd?: string
          viewMode?: 'terminal' | 'chat'
          activate?: boolean
        }
      ) => Promise<{ tabId: string; title?: string }>
    }
    const revealPromise = notifier.revealTerminalSession('wt-1', {
      ptyId: 'pty-1',
      title: 'SSH tmux',
      cwd: '/repo/packages/web',
      viewMode: 'chat'
    })
    const sentPayload = sendMock.mock.calls.find(
      ([channel]) => channel === 'ui:createTerminal'
    )?.[1]
    const handler = onMock.mock.calls.find(
      ([channel]) => channel === 'terminal:tabCreateReply'
    )?.[1]
    expect(sentPayload).toMatchObject({ cwd: '/repo/packages/web', viewMode: 'chat' })

    handler?.(
      { sender: { send: vi.fn() } },
      { requestId: sentPayload.requestId, error: 'spoofed renderer reply' }
    )
    expect(removeListenerMock).not.toHaveBeenCalledWith('terminal:tabCreateReply', handler)

    handler?.(
      { sender: mainWindow.webContents },
      { requestId: sentPayload.requestId, tabId: 'tab-1', title: 'SSH tmux' }
    )

    await expect(revealPromise).resolves.toEqual({ tabId: 'tab-1', title: 'SSH tmux' })
    expect(removeListenerMock).toHaveBeenCalledWith('terminal:tabCreateReply', handler)
  })

  it('requires an exact renderer identity receipt for recovered worker reveals', async () => {
    const sendMock = vi.fn()
    const mainWindow = createMainWindow({ send: sendMock })
    const runtime = createRuntime()

    attachMainWindowServices(mainWindow as never, createStore(), runtime as never)

    const notifier = runtime.setNotifier.mock.calls[0][0] as {
      revealTerminalSession: (
        worktreeId: string,
        opts: {
          ptyId: string
          tabId: string
          leafId: string
          expectedProcessIdentity: { terminalHandle: string; incarnationId: string }
        }
      ) => Promise<unknown>
    }
    const opts = {
      ptyId: 'pty-worker',
      tabId: 'tab-worker',
      leafId: 'leaf-worker',
      expectedProcessIdentity: {
        terminalHandle: 'term_worker',
        incarnationId: 'inc-worker'
      }
    }
    const mismatch = notifier.revealTerminalSession('worktree-1', opts)
    const mismatchPayload = sendMock.mock.calls.at(-1)?.[1]
    const mismatchHandler = onMock.mock.calls.findLast(
      ([channel]) => channel === 'terminal:tabCreateReply'
    )?.[1]
    mismatchHandler?.(
      { sender: mainWindow.webContents },
      {
        requestId: mismatchPayload.requestId,
        tabId: 'tab-worker',
        identity: {
          worktreeId: 'worktree-1',
          tabId: 'tab-worker',
          leafId: 'leaf-worker',
          ptyId: 'pty-replacement'
        }
      }
    )
    await expect(mismatch).rejects.toThrow('terminal_reveal_identity_mismatch')

    const exact = notifier.revealTerminalSession('worktree-1', opts)
    const exactPayload = sendMock.mock.calls.at(-1)?.[1]
    const exactHandler = onMock.mock.calls.findLast(
      ([channel]) => channel === 'terminal:tabCreateReply'
    )?.[1]
    const identity = {
      worktreeId: 'worktree-1',
      tabId: 'tab-worker',
      leafId: 'leaf-worker',
      ptyId: 'pty-worker'
    }
    exactHandler?.(
      { sender: mainWindow.webContents },
      { requestId: exactPayload.requestId, tabId: 'tab-worker', identity }
    )
    await expect(exact).resolves.toEqual({
      tabId: 'tab-worker',
      title: undefined,
      identity
    })
  })

  it('keeps deferred worktree watcher setup inside the service boundary', async () => {
    const mainWindow = createMainWindow()
    const store = createStore()

    vi.useFakeTimers()
    try {
      attachMainWindowServices(mainWindow as never, store, createRuntime() as never)

      expect(setWorktreeBaseDirectoryWatcherSyncContextMock).toHaveBeenCalledWith(store, mainWindow)
      expect(scheduleWorktreeBaseDirectoryWatcherSyncMock).toHaveBeenCalledWith(store, mainWindow)

      await vi.advanceTimersByTimeAsync(100)
    } finally {
      vi.useRealTimers()
    }
  })
})
