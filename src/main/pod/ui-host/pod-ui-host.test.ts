import { mkdtempSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (() => void)[]>()
  const window = {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    isVisible: vi.fn(() => false),
    restore: vi.fn(),
    show: vi.fn(),
    webContents: { send: vi.fn() }
  }
  return {
    handlers,
    window,
    dir: { path: '' },
    app: {
      on: vi.fn((event: string, handler: () => void) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler])
      }),
      once: vi.fn((event: string, handler: () => void) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler])
      }),
      quit: vi.fn(),
      show: vi.fn(),
      focus: vi.fn()
    },
    state: { mainWindow: window as unknown, isQuitting: false },
    openSettings: vi.fn()
  }
})

vi.mock('electron', () => ({ app: mocks.app, shell: { openPath: vi.fn() } }))
vi.mock('../../startup/main-process-state', () => ({ mainProcessState: mocks.state }))
vi.mock('../../startup/main-window-actions', () => ({
  openSettingsFromSystemMenu: mocks.openSettings
}))
vi.mock('../../persistence/loading-store/user-data-path', () => ({
  getCanonicalUserDataPath: () => mocks.dir.path
}))
vi.mock('../../runtime/runtime-metadata', () => ({
  readRuntimeMetadata: () => ({ authToken: 'token' })
}))
vi.mock('./pod-ui-host-launch', () => ({
  isPodUiHostLaunch: () => true,
  podUiHostOuterApp: () => null,
  POD_UI_HOST_SWITCH: '--pod-ui-host'
}))

type Client = { socket: Socket; lines: string[] }
const clients: Socket[] = []

async function attach(): Promise<Client> {
  const socketPath = join(mocks.dir.path, 'pod-ui-host.sock')
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
  socket.write(`${JSON.stringify({ type: 'hello', v: 1, token: 'token', pid: 7 })}\n`)
  await vi.waitFor(() => expect(lines[0]).toContain('welcome'))
  return { socket, lines }
}

function send(client: Client, message: unknown): void {
  client.socket.write(`${JSON.stringify(message)}\n`)
}

async function install(): Promise<void> {
  vi.resetModules()
  const { installPodUiHost } = await import('./pod-ui-host')
  installPodUiHost()
}

beforeEach(() => {
  mocks.dir.path = mkdtempSync('/tmp/pod-ui-host-app-')
  mocks.handlers.clear()
  mocks.state.isQuitting = false
  mocks.state.mainWindow = mocks.window
  vi.unstubAllEnvs()
  vi.stubEnv('ORCA_BACKGROUND_LAUNCH', '')
})

afterEach(() => {
  for (const socket of clients.splice(0)) {
    socket.destroy()
  }
  for (const handler of mocks.handlers.get('will-quit') ?? []) {
    handler()
  }
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('installPodUiHost', () => {
  it('shows the hidden window at the asked worktree and tab', async () => {
    await install()
    const client = await attach()
    send(client, { type: 'show', surface: 'window', worktreeId: 'repo-1::/w', tabId: 'tab-1' })
    await vi.waitFor(() =>
      expect(client.lines).toContain('{"type":"shown","surface":"window","visible":true}')
    )
    expect(mocks.window.webContents.send).toHaveBeenCalledWith('ui:activateWorktree', {
      repoId: 'repo-1',
      worktreeId: 'repo-1::/w'
    })
    expect(mocks.window.webContents.send).toHaveBeenCalledWith('ui:focusTerminal', {
      tabId: 'tab-1',
      worktreeId: 'repo-1::/w'
    })
    expect(mocks.app.show).toHaveBeenCalled()
    expect(mocks.window.show).toHaveBeenCalled()
  })

  it('navigates but never takes the screen in a background launch', async () => {
    vi.stubEnv('ORCA_BACKGROUND_LAUNCH', '1')
    await install()
    const client = await attach()
    send(client, { type: 'show', surface: 'settings' })
    await vi.waitFor(() =>
      expect(client.lines).toContain('{"type":"shown","surface":"settings","visible":false}')
    )
    expect(mocks.openSettings).toHaveBeenCalled()
    expect(mocks.window.show).not.toHaveBeenCalled()
    expect(mocks.app.focus).not.toHaveBeenCalled()
  })

  it('quits when PodNative asks, and tells it nothing back', async () => {
    await install()
    const client = await attach()
    send(client, { type: 'quit' })
    await vi.waitFor(() => expect(mocks.app.quit).toHaveBeenCalledTimes(1))
    expect(mocks.state.isQuitting).toBe(true)
    for (const handler of mocks.handlers.get('before-quit') ?? []) {
      handler()
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(client.lines.some((line) => line.includes('quitRequested'))).toBe(false)
  })

  it('tells PodNative when something else quits the runtime', async () => {
    await install()
    const client = await attach()
    for (const handler of mocks.handlers.get('before-quit') ?? []) {
      handler()
    }
    await vi.waitFor(() => expect(client.lines).toContain('{"type":"quitRequested"}'))
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
