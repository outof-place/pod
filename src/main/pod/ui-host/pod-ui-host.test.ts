import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>()
  const on = (event: string, handler: (...args: unknown[]) => void): void => {
    handlers.set(event, [...(handlers.get(event) ?? []), handler])
  }
  const ipcHandlers = new Map<string, ((...args: unknown[]) => void)[]>()
  const webContentsHandlers = new Map<string, () => void>()
  const window = {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    isVisible: vi.fn(() => false),
    restore: vi.fn(),
    show: vi.fn(),
    webContents: {
      id: 31,
      send: vi.fn(),
      isCrashed: () => false,
      isLoadingMainFrame: () => false,
      isFocused: () => false,
      setBackgroundThrottling: vi.fn(),
      capturePage: vi.fn(async () => undefined),
      once: vi.fn((event: string, handler: () => void) => webContentsHandlers.set(event, handler))
    }
  }
  const state: {
    mainWindow: unknown
    isQuitting: boolean
    agentAwakeService: { getWorkingAgentCount: () => number }
    desktopActivationGate: { getState: () => string } | null
  } = {
    mainWindow: window,
    isQuitting: false,
    agentAwakeService: { getWorkingAgentCount: () => 2 },
    desktopActivationGate: null
  }
  return {
    handlers,
    ipcHandlers,
    webContentsHandlers,
    ipcMain: {
      on: vi.fn((channel: string, handler: (...args: unknown[]) => void) => {
        ipcHandlers.set(channel, [...(ipcHandlers.get(channel) ?? []), handler])
      }),
      removeListener: vi.fn((channel: string, handler: (...args: unknown[]) => void) => {
        ipcHandlers.set(
          channel,
          (ipcHandlers.get(channel) ?? []).filter((entry) => entry !== handler)
        )
      })
    },
    window,
    dir: { path: '' },
    app: {
      on: vi.fn(on),
      once: vi.fn(on),
      emit: vi.fn(),
      quit: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      getAppPath: () => '/app',
      isPackaged: false
    },
    state,
    headless: { value: false },
    openWindow: vi.fn(),
    openSettings: vi.fn(),
    panes: { handle: vi.fn(), reset: vi.fn() }
  }
})

vi.mock('electron', () => ({
  app: mocks.app,
  ipcMain: mocks.ipcMain,
  shell: { openPath: vi.fn() },
  powerMonitor: { on: vi.fn() }
}))
vi.mock('../../startup/main-process-state', () => ({ mainProcessState: mocks.state }))
vi.mock('../../startup/main-window-actions', () => ({
  openSettingsFromSystemMenu: mocks.openSettings,
  showMainWindowFromTray: mocks.openWindow
}))
vi.mock('../../persistence/loading-store/user-data-path', () => ({
  getCanonicalUserDataPath: () => mocks.dir.path
}))
vi.mock('../../runtime/runtime-metadata', () => ({
  readRuntimeMetadata: () => ({ authToken: 'token' })
}))
vi.mock('../../product-identity/product-identity', () => ({ productUrlSchemes: () => ['pod'] }))
vi.mock('./pod-peer-identity', () => ({
  loadPodPeerVerifier: () => () => ({ ok: true, pid: 7 }),
  podPeerIdentityAddonPath: () => '/addon'
}))
vi.mock('../browser-pane/pod-browser-pane-host', () => ({
  installPodBrowserPanes: () => mocks.panes
}))
vi.mock('./pod-ui-host-launch', () => ({
  isPodUiHostLaunch: () => true,
  isPodHeadlessUiHost: () => mocks.headless.value,
  podUiHostOuterApp: () => null,
  POD_UI_HOST_SWITCH: '--pod-ui-host'
}))

type Client = { socket: Socket; lines: string[] }
const clients: Socket[] = []

function fire(event: string, ...args: unknown[]): void {
  for (const handler of mocks.handlers.get(event) ?? []) {
    handler(...args)
  }
}

async function attach(v = 1): Promise<Client> {
  const socketPath = join(mocks.dir.path, 'pod-ui-host', 'host.sock')
  await vi.waitFor(() => {
    const probe = createConnection(socketPath)
    return new Promise<void>((resolve, reject) => {
      probe.once('connect', () => {
        probe.destroy()
        resolve()
      })
      probe.once('error', reject)
    })
  })
  const socket = createConnection(socketPath)
  clients.push(socket)
  const lines: string[] = []
  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => lines.push(...chunk.split('\n').filter(Boolean)))
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()))
  socket.write(`${JSON.stringify({ type: 'hello', v, token: 'token', pid: 7 })}\n`)
  await vi.waitFor(() => expect(lines[0]).toContain('welcome'))
  return { socket, lines }
}

function send(client: Client, message: unknown): void {
  client.socket.write(`${JSON.stringify(message)}\n`)
}

async function install(): Promise<void> {
  vi.resetModules()
  const { installPodUiHost } = await import('./pod-ui-host')
  installPodUiHost({ setOffscreenBrowserBackend: vi.fn() })
}

// The renderer's answer to main's quit question (use-pod-ui-host-quit-assess.ts).
function rendererAnswers(blockers: unknown): void {
  mocks.window.webContents.send.mockImplementation((channel: string, requestId?: unknown) => {
    if (channel === 'pod:uiHostQuit:assess') {
      for (const handler of mocks.ipcHandlers.get('pod:uiHostQuit:assessed') ?? []) {
        handler({ sender: { id: 31 } }, requestId, blockers)
      }
    }
  })
}

const parsed = (client: Client): { type: string }[] => client.lines.map((line) => JSON.parse(line))

beforeEach(() => {
  mocks.dir.path = mkdtempSync('/tmp/pod-ui-host-app-')
  mocks.handlers.clear()
  mocks.ipcHandlers.clear()
  mocks.webContentsHandlers.clear()
  mocks.window.webContents.send.mockReset()
  mocks.state.isQuitting = false
  mocks.state.mainWindow = mocks.window
  mocks.state.desktopActivationGate = null
  mocks.headless.value = false
  vi.unstubAllEnvs()
  vi.stubEnv('ORCA_BACKGROUND_LAUNCH', '')
})

afterEach(() => {
  for (const socket of clients.splice(0)) {
    socket.destroy()
  }
  fire('will-quit')
  rmSync(mocks.dir.path, { recursive: true, force: true })
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('installPodUiHost', () => {
  it('shows the hidden window at the asked worktree and tab', async () => {
    await install()
    const client = await attach()
    send(client, { type: 'openSurface', surface: 'window', worktreeId: 'repo-1::/w', tabId: 't' })
    await vi.waitFor(() =>
      expect(client.lines).toContain('{"type":"surfaceShown","surface":"window","visible":true}')
    )
    expect(mocks.window.webContents.send).toHaveBeenCalledWith('ui:activateWorktree', {
      repoId: 'repo-1',
      worktreeId: 'repo-1::/w'
    })
    expect(mocks.window.webContents.send).toHaveBeenCalledWith('ui:focusTerminal', {
      tabId: 't',
      worktreeId: 'repo-1::/w'
    })
    expect(mocks.app.show).toHaveBeenCalled()
    expect(mocks.window.show).toHaveBeenCalled()
  })

  it('navigates but never takes the screen in a background launch', async () => {
    vi.stubEnv('ORCA_BACKGROUND_LAUNCH', '1')
    await install()
    const client = await attach()
    send(client, { type: 'openSurface', surface: 'settings' })
    await vi.waitFor(() =>
      expect(client.lines).toContain('{"type":"surfaceShown","surface":"settings","visible":false}')
    )
    expect(mocks.openSettings).toHaveBeenCalled()
    expect(mocks.window.show).not.toHaveBeenCalled()
    expect(mocks.app.focus).not.toHaveBeenCalled()
  })

  it('hands Pod URLs and documents to the second-launch path, and shows the window', async () => {
    const file = join(mocks.dir.path, 'notes.md')
    writeFileSync(file, '# notes')
    await install()
    const client = await attach()
    send(client, {
      type: 'secondInstance',
      urls: ['pod://skills/abc', 'https://example.com', 'file:///etc/passwd'],
      files: [file, 'relative.md', join(mocks.dir.path, 'missing.md'), mocks.dir.path]
    })
    await vi.waitFor(() => expect(mocks.app.emit).toHaveBeenCalledTimes(1))
    expect(mocks.app.emit.mock.calls[0][0]).toBe('second-instance')
    expect(mocks.app.emit.mock.calls[0][2]).toEqual([process.execPath, 'pod://skills/abc', file])
    await vi.waitFor(() => expect(client.lines.some((l) => l.includes('surfaceShown'))).toBe(true))
  })

  it('drops a forward with nothing Pod can open', async () => {
    await install()
    const client = await attach()
    send(client, { type: 'secondInstance', urls: ['https://example.com'], files: ['/nope'] })
    send(client, { type: 'openSurface', surface: 'settings' })
    await vi.waitFor(() => expect(mocks.openSettings).toHaveBeenCalled())
    expect(mocks.app.emit).not.toHaveBeenCalled()
  })

  it('quits when PodNative asks, and tells it nothing back', async () => {
    await install()
    const client = await attach()
    send(client, { type: 'quit', reason: 'update' })
    await vi.waitFor(() => expect(mocks.app.quit).toHaveBeenCalledTimes(1))
    expect(mocks.state.isQuitting).toBe(true)
    fire('before-quit')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(client.lines.some((line) => line.includes('quitRequested'))).toBe(false)
  })

  describe('a version 2 quit', () => {
    it('answers quitting and beats through teardown when nothing would be lost', async () => {
      rendererAnswers({ unsavedFiles: 0, remoteWork: 'none' })
      await install()
      const client = await attach(2)
      send(client, { type: 'quit', reason: 'user' })
      await vi.waitFor(() => expect(mocks.app.quit).toHaveBeenCalledTimes(1))
      expect(mocks.state.isQuitting).toBe(true)
      expect(mocks.window.webContents.send).toHaveBeenCalledWith('pod:uiHostQuit:commit')
      // The question ran unthrottled, then the renderer went back to its throttling.
      expect(mocks.window.webContents.setBackgroundThrottling.mock.calls).toEqual([[false], [true]])
      await vi.waitFor(() =>
        expect(parsed(client)).toContainEqual({ type: 'quitting', reason: 'user' })
      )
      // Teardown starts: no new connections, but the heartbeat still reaches this one.
      fire('will-quit')
      await vi.waitFor(() => expect(parsed(client)).toContainEqual({ type: 'quitHeartbeat' }), {
        timeout: 2_500
      })
      fire('before-quit')
      expect(client.lines.some((line) => line.includes('quitRequested'))).toBe(false)
    })

    it('asks for confirmation over unsaved changes and quits only once confirmed', async () => {
      rendererAnswers({ unsavedFiles: 1, remoteWork: 'none' })
      await install()
      const client = await attach(2)
      send(client, { type: 'quit', reason: 'update' })
      await vi.waitFor(() =>
        expect(parsed(client)).toContainEqual({
          type: 'needsConfirmation',
          reason: 'unsavedChanges',
          unsavedFiles: 1,
          remoteWork: null,
          runningAgents: 2
        })
      )
      expect(mocks.app.quit).not.toHaveBeenCalled()
      expect(mocks.state.isQuitting).toBe(false)
      send(client, { type: 'quit', reason: 'update', confirmed: true })
      await vi.waitFor(() => expect(mocks.app.quit).toHaveBeenCalledTimes(1))
      expect(parsed(client)).toContainEqual({ type: 'quitting', reason: 'update' })
    })

    it('quits when the renderer does not answer in time', async () => {
      await install()
      const client = await attach(2)
      send(client, { type: 'quit', reason: 'user' })
      await vi.waitFor(() => expect(mocks.app.quit).toHaveBeenCalledTimes(1), { timeout: 4_000 })
      await vi.waitFor(() =>
        expect(parsed(client)).toContainEqual({ type: 'quitting', reason: 'user' })
      )
    })

    it('reports a quit the renderer vetoed, and a later crash counts as one again', async () => {
      rendererAnswers({ unsavedFiles: 0, remoteWork: 'none' })
      await install()
      const client = await attach(2)
      send(client, { type: 'quit', reason: 'user' })
      await vi.waitFor(() => expect(mocks.app.quit).toHaveBeenCalledTimes(1))
      mocks.webContentsHandlers.get('will-prevent-unload')?.()
      await vi.waitFor(() =>
        expect(parsed(client)).toContainEqual({
          type: 'quitAborted',
          reason: 'the session could not be saved'
        })
      )
    })
  })

  it('tells PodNative when something else quits the runtime', async () => {
    await install()
    const client = await attach()
    fire('before-quit')
    await vi.waitFor(() =>
      expect(client.lines).toContain('{"type":"quitRequested","reason":"user"}')
    )
  })

  it('asks PodNative forward on a reopen or a second launch of the runtime', async () => {
    await install()
    const client = await attach()
    fire('activate')
    fire('second-instance', {}, ['Pod'])
    await vi.waitFor(() =>
      expect(client.lines.filter((line) => line === '{"type":"activate"}')).toHaveLength(2)
    )
  })

  describe('the headless runtime', () => {
    const rendererReady = (senderId = 31): void => {
      for (const handler of mocks.ipcHandlers.get('pod:uiHostSurface:ready') ?? []) {
        handler({ sender: { id: senderId } })
      }
    }

    beforeEach(() => {
      mocks.headless.value = true
      mocks.state.mainWindow = null
      mocks.openWindow.mockImplementation(() => {
        mocks.state.mainWindow = mocks.window
      })
    })

    it('opens a window only for a surface, and navigates it once the session is restored', async () => {
      await install()
      const client = await attach()
      send(client, { type: 'openSurface', surface: 'window', worktreeId: 'repo-1::/w', tabId: 't' })
      await vi.waitFor(() => expect(mocks.openWindow).toHaveBeenCalledTimes(1))
      rendererReady(99)
      expect(mocks.window.webContents.send).not.toHaveBeenCalled()
      rendererReady()
      await vi.waitFor(() =>
        expect(client.lines).toContain('{"type":"surfaceShown","surface":"window","visible":true}')
      )
      expect(mocks.window.webContents.send).toHaveBeenCalledWith('ui:activateWorktree', {
        repoId: 'repo-1',
        worktreeId: 'repo-1::/w'
      })
      send(client, { type: 'openSurface', surface: 'settings' })
      await vi.waitFor(() => expect(mocks.openSettings).toHaveBeenCalled())
      expect(mocks.openWindow).toHaveBeenCalledTimes(1)
    })

    it('refuses a surface while no window may open', async () => {
      mocks.state.desktopActivationGate = { getState: () => 'initializing' }
      await install()
      const client = await attach()
      send(client, { type: 'openSurface', surface: 'window' })
      await vi.waitFor(() =>
        expect(client.lines).toContain('{"type":"surfaceShown","surface":"window","visible":false}')
      )
      expect(mocks.openWindow).not.toHaveBeenCalled()
    })

    it('leaves an unmarked quit to the serve veto, which asks PodNative itself', async () => {
      await install()
      const { markProcessQuitRequested } = await import('../../startup/process-quit-request')
      const client = await attach()
      fire('before-quit')
      send(client, { type: 'openSurface', surface: 'window' })
      await vi.waitFor(() => expect(mocks.openWindow).toHaveBeenCalled())
      expect(client.lines.some((line) => line.includes('quitRequested'))).toBe(false)
      markProcessQuitRequested()
      fire('before-quit')
      await vi.waitFor(() =>
        expect(client.lines).toContain('{"type":"quitRequested","reason":"user"}')
      )
    })
  })

  it('quits a minute after PodNative vanished, unless a fallback window is on screen', async () => {
    await install()
    const client = await attach()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    client.socket.destroy()
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1))
    mocks.window.isVisible.mockReturnValueOnce(true)
    vi.advanceTimersByTime(60_000)
    expect(mocks.app.quit).not.toHaveBeenCalled()

    vi.useRealTimers()
    const again = await attach()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    again.socket.destroy()
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1))
    vi.advanceTimersByTime(59_000)
    expect(mocks.app.quit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1_000)
    expect(mocks.app.quit).toHaveBeenCalledTimes(1)
  })
})
