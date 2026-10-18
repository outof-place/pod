import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AgentBrowserDaemonCancelled,
  AgentBrowserDaemonTimeout,
  AgentBrowserDaemonUnreachable,
  agentBrowserDaemonEndpoint,
  agentBrowserDaemonSpeaksSupportedProtocol,
  exchangeAgentBrowserDaemonCommand
} from './agent-browser-daemon-socket'

const COMMAND = { id: 'p1', action: 'click', selector: '@e1' }

let directory = ''
let server: Server | null = null

beforeEach(() => {
  directory = mkdtempSync('/tmp/abs-')
})

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = null
  rmSync(directory, { recursive: true, force: true })
})

function listen(onLine: (line: string, socket: Socket) => void): Promise<string> {
  const path = join(directory, 's.sock')
  server = createServer((socket) => {
    let buffered = ''
    socket.on('data', (chunk) => {
      buffered += chunk.toString('utf8')
      const newline = buffered.indexOf('\n')
      if (newline !== -1) {
        onLine(buffered.slice(0, newline), socket)
      }
    })
  })
  return new Promise((resolve) => server!.listen(path, () => resolve(path)))
}

describe('exchangeAgentBrowserDaemonCommand', () => {
  it('sends one JSON line and returns the daemon reply line', async () => {
    const lines: string[] = []
    const path = await listen((line, socket) => {
      lines.push(line)
      // Split across writes, as a large reply arrives.
      socket.write('{"success":true,')
      socket.write('"data":{"clicked":"@e1"}}\n')
    })
    const { reply } = exchangeAgentBrowserDaemonCommand({ path }, COMMAND, 1_000)
    await expect(reply).resolves.toBe('{"success":true,"data":{"clicked":"@e1"}}')
    expect(lines.map((line) => JSON.parse(line))).toEqual([COMMAND])
  })

  it('reports a missing socket as unreachable, so the CLI can start a daemon', async () => {
    const { reply } = exchangeAgentBrowserDaemonCommand(
      { path: join(directory, 'none.sock') },
      COMMAND,
      1_000
    )
    await expect(reply).rejects.toBeInstanceOf(AgentBrowserDaemonUnreachable)
  })

  it('times out a daemon that never answers', async () => {
    const path = await listen(() => {})
    const { reply } = exchangeAgentBrowserDaemonCommand({ path }, COMMAND, 50)
    await expect(reply).rejects.toBeInstanceOf(AgentBrowserDaemonTimeout)
  })

  it('cancels a pending command', async () => {
    const path = await listen(() => {})
    const exchange = exchangeAgentBrowserDaemonCommand({ path }, COMMAND, 5_000)
    setTimeout(() => exchange.cancel(), 20)
    await expect(exchange.reply).rejects.toBeInstanceOf(AgentBrowserDaemonCancelled)
  })

  it('does not call a daemon that hung up after the command unreachable', async () => {
    const path = await listen((_line, socket) => socket.destroy())
    const { reply } = exchangeAgentBrowserDaemonCommand({ path }, COMMAND, 1_000)
    const error = await reply.catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(AgentBrowserDaemonUnreachable)
  })
})

describe('agentBrowserDaemonEndpoint', () => {
  it('is the session socket under the socket directory on unix', () => {
    expect(
      agentBrowserDaemonEndpoint({ AGENT_BROWSER_SOCKET_DIR: directory }, 'orca-tab-1', 'darwin')
    ).toEqual({ path: join(directory, 'orca-tab-1.sock') })
  })

  // Expected ports are agent-browser's own (connection.rs test_get_port_for_session).
  it.each([
    ['default', 50838],
    ['my-session', 63105],
    ['work', 51184],
    ['', 49152]
  ])('hashes %j to the CLI port %i on Windows', (session, port) => {
    expect(
      agentBrowserDaemonEndpoint({ AGENT_BROWSER_SOCKET_DIR: directory }, session, 'win32')
    ).toEqual({ host: '127.0.0.1', port })
  })

  it('prefers the port the Windows daemon wrote', () => {
    writeFileSync(join(directory, 'work.port'), '61234\n')
    expect(
      agentBrowserDaemonEndpoint({ AGENT_BROWSER_SOCKET_DIR: directory }, 'work', 'win32')
    ).toEqual({ host: '127.0.0.1', port: 61234 })
  })
})

describe('agentBrowserDaemonSpeaksSupportedProtocol', () => {
  it.each([
    ['0.27.3', true],
    ['0.27.9\n', true],
    ['0.28.0', false],
    ['1.0.0', false]
  ])('daemon %j: %s', (version, expected) => {
    writeFileSync(join(directory, 's.version'), version)
    expect(
      agentBrowserDaemonSpeaksSupportedProtocol({ AGENT_BROWSER_SOCKET_DIR: directory }, 's')
    ).toBe(expected)
  })

  it('is false without a version file', () => {
    expect(
      agentBrowserDaemonSpeaksSupportedProtocol({ AGENT_BROWSER_SOCKET_DIR: directory }, 's')
    ).toBe(false)
  })
})
