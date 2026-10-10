import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
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

async function startServer(overrides: Partial<PodUiHostServerOptions> = {}) {
  // Why /tmp: sun_path is 104 bytes and macOS's per-user tmpdir is long.
  const dir = mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'pod-ui-host-'))
  const options: PodUiHostServerOptions = {
    socketPath: join(dir, 'pod-ui-host.sock'),
    readToken: () => TOKEN,
    pid: 4242,
    onShow: vi.fn(),
    onQuit: vi.fn(),
    onUiPresence: vi.fn(),
    log: () => {},
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
  it('listens on a socket only its user can open', async () => {
    const { options } = await startServer()
    expect(statSync(options.socketPath).mode & 0o777).toBe(0o600)
  })

  it('welcomes a hello with the runtime token and reports the UI attached', async () => {
    const { server, options } = await startServer()
    const client = await hello(options.socketPath)
    expect(JSON.parse(client.lines[0])).toEqual({ type: 'welcome', v: 1, pid: 4242 })
    expect(options.onUiPresence).toHaveBeenCalledWith(true)
    expect(server.attached).toBe(true)
  })

  it('closes a connection whose hello carries another token', async () => {
    const { server, options } = await startServer()
    const client = await connect(options.socketPath)
    send(client, { type: 'hello', v: 1, token: 'stale-token', pid: 99 })
    await client.closed
    expect(client.lines).toEqual([])
    expect(server.attached).toBe(false)
    expect(options.onUiPresence).not.toHaveBeenCalled()
  })

  it('closes a connection that asks for anything before its hello', async () => {
    const { options } = await startServer()
    const client = await connect(options.socketPath)
    send(client, { type: 'quit' })
    await client.closed
    expect(options.onQuit).not.toHaveBeenCalled()
  })

  it('refuses every hello while the runtime has no token yet', async () => {
    const { options } = await startServer({ readToken: () => null })
    const client = await connect(options.socketPath)
    send(client, { type: 'hello', v: 1, token: TOKEN, pid: 99 })
    await client.closed
  })

  it('routes show and quit from the attached UI', async () => {
    const { options } = await startServer()
    const client = await hello(options.socketPath)
    send(client, { type: 'show', surface: 'window', worktreeId: 'repo::/w' })
    send(client, { type: 'quit' })
    await vi.waitFor(() => expect(options.onQuit).toHaveBeenCalledTimes(1))
    expect(options.onShow).toHaveBeenCalledWith({
      type: 'show',
      surface: 'window',
      worktreeId: 'repo::/w'
    })
  })

  it('reports the UI gone when it disconnects without quitting, not after a quit', async () => {
    const { options } = await startServer()
    const crashed = await hello(options.socketPath)
    crashed.socket.destroy()
    await vi.waitFor(() => expect(options.onUiPresence).toHaveBeenLastCalledWith(false))

    const quitting = await hello(options.socketPath)
    send(quitting, { type: 'quit' })
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
    expect(server.send({ type: 'hidden' })).toBe(true)
    await vi.waitFor(() => expect(second.lines).toContain('{"type":"hidden"}'))
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
      socketPath: `/tmp/${'x'.repeat(120)}.sock`,
      readToken: () => TOKEN,
      pid: 1,
      onShow: () => {},
      onQuit: () => {},
      onUiPresence: () => {},
      log: () => {}
    })
    expect(await server.start()).toBe(false)
  })
})
