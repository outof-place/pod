import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isPodHeadlessUiHost, isPodUiHostLaunch, podUiHostOuterApp } from './pod-ui-host-launch'
import { PodUiHostServer, type PodUiHostServerOptions } from './pod-ui-host-server'

const TOKEN = 'runtime-token'
const servers: PodUiHostServer[] = []
const sockets: Socket[] = []
const scratchDirectories: string[] = []

afterEach(() => {
  for (const socket of sockets.splice(0)) {
    socket.destroy()
  }
  for (const server of servers.splice(0)) {
    server.close()
  }
  for (const directory of scratchDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

// Why /tmp: sun_path is 104 bytes and macOS's per-user tmpdir is long.
function scratch(): string {
  const directory = mkdtempSync(
    join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'pod-ui-host-')
  )
  scratchDirectories.push(directory)
  return directory
}

async function startServer(overrides: Partial<PodUiHostServerOptions> = {}) {
  const options: PodUiHostServerOptions = {
    socketPath: join(scratch(), 'pod-ui-host', 'host.sock'),
    readToken: () => TOKEN,
    verifyPeer: () => ({ ok: true, pid: 99 }),
    pid: 4242,
    onOpenSurface: vi.fn(),
    onSecondInstance: vi.fn(),
    onQuit: vi.fn(),
    onUiPresence: vi.fn(),
    log: vi.fn(),
    ...overrides
  }
  const server = new PodUiHostServer(options)
  servers.push(server)
  expect(await server.start()).toBe(true)
  return { server, options }
}

type Client = { socket: Socket; lines: string[]; closed: Promise<void> }

async function connect(path: string): Promise<Client> {
  const socket = createConnection(path)
  sockets.push(socket)
  const lines: string[] = []
  let buffered = ''
  socket.setEncoding('utf8')
  socket.on('error', () => {})
  socket.on('data', (chunk: string) => {
    buffered += chunk
    let newline = buffered.indexOf('\n')
    while (newline !== -1) {
      lines.push(buffered.slice(0, newline))
      buffered = buffered.slice(newline + 1)
      newline = buffered.indexOf('\n')
    }
  })
  const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()))
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()))
  return { socket, lines, closed }
}

function send(client: Client, message: unknown): void {
  client.socket.write(`${JSON.stringify(message)}\n`)
}

async function hello(path: string, token = TOKEN, v = 1): Promise<Client> {
  const client = await connect(path)
  send(client, { type: 'hello', v, token, pid: 99 })
  await vi.waitFor(() => expect(client.lines.length).toBeGreaterThan(0))
  return client
}

describe('isPodUiHostLaunch', () => {
  const classic = '/Applications/Pod.app/Contents/MacOS/Pod'
  const nested = '/Applications/Pod.app/Contents/Helpers/Pod Runtime.app/Contents/MacOS/Pod'

  it('needs the switch on macOS; serve only as the headless one-app runtime', () => {
    expect(isPodUiHostLaunch(['Pod', '--pod-ui-host'], 'darwin', classic)).toBe(true)
    expect(isPodUiHostLaunch(['Pod'], 'darwin', classic)).toBe(false)
    expect(isPodUiHostLaunch(['Pod', '--pod-ui-host'], 'linux', classic)).toBe(false)
    expect(isPodUiHostLaunch(['Pod', '--pod-ui-host', '--serve'], 'darwin', classic)).toBe(false)
    expect(isPodUiHostLaunch(['Pod', '--serve', '--pod-headless-host'], 'darwin', classic)).toBe(
      false
    )
    const headless = ['Pod', '--pod-ui-host', '--serve', '--pod-headless-host']
    expect(isPodUiHostLaunch(headless, 'darwin', classic)).toBe(true)
    expect(isPodHeadlessUiHost(headless, 'darwin', classic)).toBe(true)
    expect(isPodHeadlessUiHost(headless, 'linux', classic)).toBe(false)
    expect(isPodHeadlessUiHost(['Pod', '--pod-ui-host'], 'darwin', classic)).toBe(false)
  })

  it('applies to the one-app helper however it was started, except a plain serve', () => {
    expect(isPodUiHostLaunch(['Pod'], 'darwin', nested)).toBe(true)
    expect(isPodUiHostLaunch(['Pod', '--serve'], 'darwin', nested)).toBe(false)
    expect(isPodUiHostLaunch(['Pod', '--serve', '--pod-headless-host'], 'darwin', nested)).toBe(
      false
    )
    expect(podUiHostOuterApp(nested)).toBe('/Applications/Pod.app')
    expect(podUiHostOuterApp(classic)).toBeNull()
  })
})

describe('PodUiHostServer', () => {
  it('listens on a 0600 socket in a 0700 directory', async () => {
    const { options } = await startServer()
    expect(statSync(options.socketPath).mode & 0o777).toBe(0o600)
    expect(statSync(join(options.socketPath, '..')).mode & 0o777).toBe(0o700)
  })

  it('tightens its own directory to 0700', async () => {
    const directory = join(scratch(), 'pod-ui-host')
    mkdirSync(directory, { mode: 0o755 })
    chmodSync(directory, 0o755)
    await startServer({ socketPath: join(directory, 'host.sock') })
    expect(statSync(directory).mode & 0o777).toBe(0o700)
  })

  it('refuses to listen in a directory that is a link', async () => {
    const root = scratch()
    mkdirSync(join(root, 'elsewhere'))
    symlinkSync(join(root, 'elsewhere'), join(root, 'pod-ui-host'))
    const server = new PodUiHostServer({
      socketPath: join(root, 'pod-ui-host', 'host.sock'),
      readToken: () => TOKEN,
      verifyPeer: () => ({ ok: true, pid: 1 }),
      pid: 1,
      onOpenSurface: () => {},
      onSecondInstance: () => {},
      onQuit: () => {},
      onUiPresence: () => {},
      log: () => {}
    })
    servers.push(server)
    expect(await server.start()).toBe(false)
  })

  it('welcomes an admitted peer whose hello carries the runtime token', async () => {
    const { server, options } = await startServer()
    const client = await hello(options.socketPath)
    expect(JSON.parse(client.lines[0])).toEqual({
      type: 'welcome',
      v: 1,
      pid: 4242,
      features: ['surfaceSection']
    })
    expect(options.onUiPresence).toHaveBeenCalledWith(true)
    expect(server.attached).toBe(true)
  })

  it('welcomes a version 2 PodNative in its own version', async () => {
    const { options } = await startServer()
    const client = await hello(options.socketPath, TOKEN, 2)
    expect(JSON.parse(client.lines[0])).toEqual({
      type: 'welcome',
      v: 2,
      pid: 4242,
      features: ['surfaceSection']
    })
  })

  describe('browser verbs', () => {
    const attach = {
      type: 'browserAttach',
      pageId: 'page-1',
      token: 7,
      width: 800,
      height: 600,
      scale: 2
    }

    it('names headless for the headless runtime, next to browser', async () => {
      const { options } = await startServer({ onBrowser: vi.fn(), headless: true })
      const client = await hello(options.socketPath)
      expect(JSON.parse(client.lines[0]).features).toEqual([
        'browser',
        'headless',
        'surfaceSection'
      ])
    })

    it('names the browser feature and routes its verbs when the runtime takes them', async () => {
      const onBrowser = vi.fn()
      const { options } = await startServer({ onBrowser })
      const client = await hello(options.socketPath)
      expect(JSON.parse(client.lines[0]).features).toEqual(['browser', 'surfaceSection'])
      send(client, attach)
      send(client, {
        type: 'browserNavigate',
        pageId: 'page-1',
        action: 'load',
        url: 'https://example.com'
      })
      await vi.waitFor(() => expect(onBrowser).toHaveBeenCalledTimes(2))
      expect(onBrowser.mock.calls[0][0]).toEqual(attach)
    })

    it('takes browserPane only from a version 3 PodNative', async () => {
      const pane = { type: 'browserPane', pageId: 'page-1', visible: false }
      const onBrowser = vi.fn()
      const { options } = await startServer({ onBrowser })
      const current = await hello(options.socketPath, TOKEN, 3)
      send(current, pane)
      await vi.waitFor(() => expect(onBrowser).toHaveBeenCalledWith(pane))
      const older = await hello(options.socketPath, TOKEN, 2)
      send(older, pane)
      await older.closed
      expect(onBrowser).toHaveBeenCalledTimes(1)
    })

    it('ends the connection on a browser verb this runtime did not offer', async () => {
      const { options } = await startServer()
      const client = await hello(options.socketPath)
      send(client, attach)
      await client.closed
    })

    it.each([
      [
        'a rendezvous name of another app',
        { type: 'browserRendezvous', service: 'com.evil.browser.0123456789abcdef0123456789abcdef' }
      ],
      ['a token of 0', { ...attach, token: 0 }],
      ['a pane visibility that is not a boolean', { type: 'browserPane', pageId: 'p', visible: 1 }],
      ['a pane with an extra field', { type: 'browserPane', pageId: 'p', visible: true, token: 7 }],
      [
        'a pane rendezvous of another app',
        {
          type: 'browserPane',
          pageId: 'p',
          visible: true,
          rendezvous: 'com.evil.browser.0123456789abcdef0123456789abcdef'
        }
      ],
      ['a size over the limit', { ...attach, width: 9000 }],
      ['a load without a URL', { type: 'browserNavigate', pageId: 'page-1', action: 'load' }],
      [
        'a back with a URL',
        { type: 'browserNavigate', pageId: 'page-1', action: 'back', url: 'https://x' }
      ],
      [
        'an input event with an extra field',
        {
          type: 'browserInput',
          pageId: 'page-1',
          event: { kind: 'text', text: 'hi', script: 'alert(1)' }
        }
      ],
      [
        'an unknown modifier',
        {
          type: 'browserInput',
          pageId: 'page-1',
          event: { kind: 'key', action: 'down', keyCode: 'A', modifiers: ['hyper'] }
        }
      ]
    ])('refuses %s and ends the connection', async (_name, message) => {
      const onBrowser = vi.fn()
      const { options } = await startServer({ onBrowser })
      // Version 3, so a refused browserPane is refused for its shape.
      const client = await hello(options.socketPath, TOKEN, 3)
      send(client, message)
      await client.closed
      expect(onBrowser).not.toHaveBeenCalled()
    })
  })

  describe('refuses', () => {
    it('a peer that is not PodNative, before reading a byte', async () => {
      const verifyPeer = vi.fn(() => ({ ok: false, pid: 77, error: 'peer fails the requirement' }))
      const { options } = await startServer({ verifyPeer })
      const client = await connect(options.socketPath)
      send(client, { type: 'hello', v: 1, token: TOKEN, pid: 77 })
      await client.closed
      expect(client.lines).toEqual([])
      expect(verifyPeer).toHaveBeenCalledTimes(1)
      expect(options.log).toHaveBeenCalledWith(
        'ui-host: refused pid 77: peer fails the requirement'
      )
    })

    it('everyone when there is no peer check', async () => {
      const { options } = await startServer({ verifyPeer: null })
      const client = await connect(options.socketPath)
      send(client, { type: 'hello', v: 1, token: TOKEN, pid: 1 })
      await client.closed
      expect(client.lines).toEqual([])
    })

    it('a hello with another token', async () => {
      const { server, options } = await startServer()
      const client = await connect(options.socketPath)
      send(client, { type: 'hello', v: 1, token: 'stale-token', pid: 99 })
      await client.closed
      expect(client.lines).toEqual([])
      expect(server.attached).toBe(false)
    })

    it('a hello while the runtime has no token yet', async () => {
      const { options } = await startServer({ readToken: () => null })
      const client = await connect(options.socketPath)
      send(client, { type: 'hello', v: 1, token: TOKEN, pid: 99 })
      await client.closed
    })

    it.each([0, 4])('a hello of protocol version %s', async (v) => {
      const { options } = await startServer()
      const client = await connect(options.socketPath)
      send(client, { type: 'hello', v, token: TOKEN, pid: 99 })
      await client.closed
      expect(client.lines).toEqual([])
    })

    it('anything before the hello', async () => {
      const { options } = await startServer()
      const client = await connect(options.socketPath)
      send(client, { type: 'quit', reason: 'user' })
      await client.closed
      expect(options.onQuit).not.toHaveBeenCalled()
    })

    it.each([
      ['an unknown verb', { type: 'exec', command: 'id' }],
      ['a second hello', { type: 'hello', v: 1, token: TOKEN, pid: 99 }],
      ['an extra field on a known verb', { type: 'quit', reason: 'user', command: 'id' }],
      ['a quit for an unknown reason', { type: 'quit', reason: 'later' }],
      ['a quit confirmed with anything but true', { type: 'quit', reason: 'user', confirmed: 1 }],
      ['an unknown surface', { type: 'openSurface', surface: 'terminal' }],
      [
        'a section that is not a plain name',
        { type: 'openSurface', surface: 'settings', section: '../accounts' }
      ],
      [
        'a forward of 33 URLs',
        { type: 'secondInstance', urls: Array(33).fill('pod://x'), files: [] }
      ]
    ])('%s after the hello, and ends the connection', async (_name, message) => {
      const { options } = await startServer()
      const client = await hello(options.socketPath)
      send(client, message)
      await client.closed
      expect(options.onQuit).not.toHaveBeenCalled()
      expect(options.onOpenSurface).not.toHaveBeenCalled()
      expect(options.onSecondInstance).not.toHaveBeenCalled()
    })

    it('a line that is not JSON', async () => {
      const { options } = await startServer()
      const client = await hello(options.socketPath)
      client.socket.write('quit\n')
      await client.closed
    })

    it('a line over 64 KiB', async () => {
      const { options } = await startServer()
      const client = await hello(options.socketPath)
      client.socket.write('x'.repeat(70 * 1024))
      await client.closed
    })
  })

  it('routes the verbs of the attached UI', async () => {
    const { options } = await startServer()
    const client = await hello(options.socketPath)
    send(client, { type: 'openSurface', surface: 'window', worktreeId: 'repo::/w' })
    send(client, {
      type: 'openSurface',
      surface: 'settings',
      section: 'repo',
      repoId: 'repo-1',
      item: 'repo-1-local-commands'
    })
    send(client, { type: 'secondInstance', urls: ['pod://skills/x'], files: [] })
    send(client, { type: 'quit', reason: 'update' })
    await vi.waitFor(() =>
      expect(options.onQuit).toHaveBeenCalledWith({
        reason: 'update',
        confirmed: false,
        version: 1
      })
    )
    expect(options.onOpenSurface).toHaveBeenCalledWith({
      type: 'openSurface',
      surface: 'window',
      worktreeId: 'repo::/w'
    })
    expect(options.onOpenSurface).toHaveBeenCalledWith({
      type: 'openSurface',
      surface: 'settings',
      section: 'repo',
      repoId: 'repo-1',
      item: 'repo-1-local-commands'
    })
    expect(options.onSecondInstance).toHaveBeenCalledWith({
      type: 'secondInstance',
      urls: ['pod://skills/x'],
      files: []
    })
  })

  it('reports the UI gone when it disconnects without quitting, not after a quit', async () => {
    const { options } = await startServer()
    const crashed = await hello(options.socketPath)
    crashed.socket.destroy()
    await vi.waitFor(() => expect(options.onUiPresence).toHaveBeenLastCalledWith(false))

    const quitting = await hello(options.socketPath)
    send(quitting, { type: 'quit', reason: 'user' })
    await vi.waitFor(() => expect(options.onQuit).toHaveBeenCalled())
    quitting.socket.destroy()
    await quitting.closed
    // attached, gone, attached: no second "gone" for the UI that asked to quit
    expect(vi.mocked(options.onUiPresence).mock.calls).toEqual([[true], [false], [true]])
  })

  it('passes a confirmed quit on with the asking version', async () => {
    const { options } = await startServer()
    const client = await hello(options.socketPath, TOKEN, 2)
    send(client, { type: 'quit', reason: 'user', confirmed: true })
    await vi.waitFor(() =>
      expect(options.onQuit).toHaveBeenCalledWith({ reason: 'user', confirmed: true, version: 2 })
    )
  })

  it('takes a version 2 PodNative that asked to quit for gone until its quit commits', async () => {
    const { server, options } = await startServer()
    const asked = await hello(options.socketPath, TOKEN, 2)
    send(asked, { type: 'quit', reason: 'user' })
    await vi.waitFor(() => expect(options.onQuit).toHaveBeenCalledTimes(1))
    // The user cancelled the confirmation, then PodNative crashed: a crash.
    asked.socket.destroy()
    await vi.waitFor(() => expect(options.onUiPresence).toHaveBeenLastCalledWith(false))

    const committed = await hello(options.socketPath, TOKEN, 2)
    send(committed, { type: 'quit', reason: 'user' })
    await vi.waitFor(() => expect(options.onQuit).toHaveBeenCalledTimes(2))
    server.noteQuitCommitted()
    committed.socket.destroy()
    await committed.closed
    expect(vi.mocked(options.onUiPresence).mock.calls).toEqual([[true], [false], [true]])
  })

  it('keeps the attached PodNative once it stops listening, for the quit heartbeat', async () => {
    const { server, options } = await startServer()
    const client = await hello(options.socketPath, TOKEN, 2)
    server.stopListening()
    expect(server.send({ type: 'quitHeartbeat' })).toBe(true)
    await vi.waitFor(() => expect(client.lines).toContain('{"type":"quitHeartbeat"}'))
    const late = createConnection(options.socketPath)
    sockets.push(late)
    await new Promise<void>((resolve) => late.once('error', () => resolve()))
  })

  it('lets a newer PodNative replace the attached one without a gone report', async () => {
    const { server, options } = await startServer()
    const first = await hello(options.socketPath)
    const second = await hello(options.socketPath)
    await first.closed
    expect(server.send({ type: 'surfaceHidden' })).toBe(true)
    await vi.waitFor(() => expect(second.lines).toContain('{"type":"surfaceHidden"}'))
    expect(vi.mocked(options.onUiPresence).mock.calls).toEqual([[true], [true]])
  })

  // Why: a burst of profile events made PodNative open several channels at once and keep the
  // first welcome, closing the later ones; the server keeps the newest, so that close read as a
  // crash and the 60 s no-UI grace ended the runtime. The newest welcome is the live channel.
  it('keeps the newest of parallel hellos; closing that one is the UI gone', async () => {
    const { server, options } = await startServer()
    // All connected before any hello; the hellos one by one, so the newest is known.
    const burst = await Promise.all([1, 2, 3].map(() => connect(options.socketPath)))
    for (const client of burst) {
      send(client, { type: 'hello', v: 3, token: TOKEN, pid: 99 })
      await vi.waitFor(() => expect(client.lines[0]).toMatch(/"type":"welcome"/))
    }
    const [first, second, newest] = burst
    await Promise.all([first.closed, second.closed])
    expect(server.attached).toBe(true)
    expect(vi.mocked(options.onUiPresence).mock.calls).toEqual([[true], [true], [true]])

    newest.socket.destroy()
    await vi.waitFor(() => expect(options.onUiPresence).toHaveBeenLastCalledWith(false))
    expect(server.attached).toBe(false)
  })

  it('sends nothing while no UI is attached', async () => {
    const { server } = await startServer()
    expect(server.send({ type: 'badge', label: '3' })).toBe(false)
  })

  it('replaces a socket a previous run left but never a regular file', async () => {
    const { server, options } = await startServer()
    server.close()
    const again = new PodUiHostServer(options)
    servers.push(again)
    expect(await again.start()).toBe(true)
    again.close()

    writeFileSync(options.socketPath, 'not a socket')
    const blocked = new PodUiHostServer(options)
    servers.push(blocked)
    expect(await blocked.start()).toBe(false)
  })

  it('does not listen on a path longer than sun_path', async () => {
    const server = new PodUiHostServer({
      socketPath: `/tmp/${'x'.repeat(120)}/host.sock`,
      readToken: () => TOKEN,
      verifyPeer: () => ({ ok: true, pid: 1 }),
      pid: 1,
      onOpenSurface: () => {},
      onSecondInstance: () => {},
      onQuit: () => {},
      onUiPresence: () => {},
      log: () => {}
    })
    expect(await server.start()).toBe(false)
  })
})
