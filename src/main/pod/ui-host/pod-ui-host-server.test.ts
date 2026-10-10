import { chmodSync, mkdirSync, mkdtempSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isPodUiHostLaunch, podUiHostOuterApp } from './pod-ui-host-launch'
import { PodUiHostServer, type PodUiHostServerOptions } from './pod-ui-host-server'

const TOKEN = 'runtime-token'
const servers: PodUiHostServer[] = []
const sockets: Socket[] = []

afterEach(() => {
  for (const socket of sockets.splice(0)) {
    socket.destroy()
  }
  for (const server of servers.splice(0)) {
    server.close()
  }
})

// Why /tmp: sun_path is 104 bytes and macOS's per-user tmpdir is long.
function scratch(): string {
  return mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'pod-ui-host-'))
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

async function hello(path: string, token = TOKEN): Promise<Client> {
  const client = await connect(path)
  send(client, { type: 'hello', v: 1, token, pid: 99 })
  await vi.waitFor(() => expect(client.lines.length).toBeGreaterThan(0))
  return client
}

describe('isPodUiHostLaunch', () => {
  const classic = '/Applications/Pod.app/Contents/MacOS/Pod'
  const nested = '/Applications/Pod.app/Contents/Helpers/Pod Runtime.app/Contents/MacOS/Pod'

  it('needs the switch on macOS and never applies to serve', () => {
    expect(isPodUiHostLaunch(['Pod', '--pod-ui-host'], 'darwin', classic)).toBe(true)
    expect(isPodUiHostLaunch(['Pod'], 'darwin', classic)).toBe(false)
    expect(isPodUiHostLaunch(['Pod', '--pod-ui-host'], 'linux', classic)).toBe(false)
    expect(isPodUiHostLaunch(['Pod', '--pod-ui-host', '--serve'], 'darwin', classic)).toBe(false)
  })

  it('applies to the one-app helper however it was started, except serve', () => {
    expect(isPodUiHostLaunch(['Pod'], 'darwin', nested)).toBe(true)
    expect(isPodUiHostLaunch(['Pod', '--serve'], 'darwin', nested)).toBe(false)
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
    expect(JSON.parse(client.lines[0])).toEqual({ type: 'welcome', v: 1, pid: 4242 })
    expect(options.onUiPresence).toHaveBeenCalledWith(true)
    expect(server.attached).toBe(true)
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

    it('a hello of another protocol version', async () => {
      const { options } = await startServer()
      const client = await connect(options.socketPath)
      send(client, { type: 'hello', v: 2, token: TOKEN, pid: 99 })
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
      ['an unknown surface', { type: 'openSurface', surface: 'terminal' }],
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
    send(client, { type: 'secondInstance', urls: ['pod://skills/x'], files: [] })
    send(client, { type: 'quit', reason: 'update' })
    await vi.waitFor(() => expect(options.onQuit).toHaveBeenCalledWith('update'))
    expect(options.onOpenSurface).toHaveBeenCalledWith({
      type: 'openSurface',
      surface: 'window',
      worktreeId: 'repo::/w'
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

  it('lets a newer PodNative replace the attached one without a gone report', async () => {
    const { server, options } = await startServer()
    const first = await hello(options.socketPath)
    const second = await hello(options.socketPath)
    await first.closed
    expect(server.send({ type: 'surfaceHidden' })).toBe(true)
    await vi.waitFor(() => expect(second.lines).toContain('{"type":"surfaceHidden"}'))
    expect(vi.mocked(options.onUiPresence).mock.calls).toEqual([[true], [true]])
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
