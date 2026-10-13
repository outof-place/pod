// The relay's kept connection to the runtime and its cached read of the endpoint file.
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deliverPodHookRelayEvent, type PodHookRelayEvent } from './pod-hook-relay-delivery'

let dir = ''
const servers: Server[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pod-hook-relay-reuse-'))
})

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))))
  rmSync(dir, { recursive: true, force: true })
})

function event(payload: string): PodHookRelayEvent {
  return {
    agent: 'claude',
    pane: {
      paneKey: 'tab-1:leaf-1',
      tabId: 'tab-1',
      launchToken: 'launch-1',
      worktreeId: 'repo::/w',
      env: 'production',
      version: '1',
      endpoint: join(dir, 'endpoint.env')
    },
    agentProcess: '{"pid":42,"platform":"darwin","startTime":"Mon Oct 12 03:00:00 2026"}',
    payload: Buffer.from(payload)
  }
}

type Runtime = { port: number; bodies: string[]; connections: number }

/** A runtime whose `drop(n)` closes a connection, unanswered, on its n-th request. */
async function fakeRuntime(drop: (nth: number) => boolean = () => false): Promise<Runtime> {
  const runtime: Runtime = { port: 0, bodies: [], connections: 0 }
  const requestsOn = new WeakMap<object, number>()
  const server = createServer((req, res) => {
    const nth = (requestsOn.get(req.socket) ?? 0) + 1
    requestsOn.set(req.socket, nth)
    if (drop(nth)) {
      req.socket.destroy()
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      runtime.bodies.push(Buffer.concat(chunks).toString())
      res.writeHead(204).end()
    })
  })
  server.on('connection', () => (runtime.connections += 1))
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  runtime.port = address && typeof address === 'object' ? address.port : 0
  return runtime
}

function writeEndpoint(port: number): void {
  writeFileSync(
    join(dir, 'endpoint.env'),
    `ORCA_AGENT_HOOK_PORT=${port}\nORCA_AGENT_HOOK_TOKEN=runtime-token\nORCA_AGENT_HOOK_TRANSPORT=raw-json-v1\n`
  )
}

describe('pod-hook-relay delivery, kept connection', () => {
  it('sends a pane’s events over the one connection the first opened', async () => {
    const runtime = await fakeRuntime()
    writeEndpoint(runtime.port)
    for (const name of ['PreToolUse', 'PostToolUse', 'Stop']) {
      expect(await deliverPodHookRelayEvent(event(`{"hook_event_name":"${name}"}`))).toBe(
        'delivered'
      )
    }
    expect(runtime.bodies).toHaveLength(3)
    expect(runtime.connections).toBe(1)
  })

  it('sends the event again on a new connection when the runtime closed the kept one', async () => {
    const runtime = await fakeRuntime((nth) => nth === 2)
    writeEndpoint(runtime.port)
    await deliverPodHookRelayEvent(event('{"hook_event_name":"PreToolUse"}'))
    expect(await deliverPodHookRelayEvent(event('{"hook_event_name":"PostToolUse"}'))).toBe(
      'delivered'
    )
    expect(runtime.bodies).toEqual([
      '{"hook_event_name":"PreToolUse"}',
      '{"hook_event_name":"PostToolUse"}'
    ])
    expect(runtime.connections).toBe(2)
  })

  it('spools, without a second try, when a new connection closes unanswered', async () => {
    const runtime = await fakeRuntime(() => true)
    writeEndpoint(runtime.port)
    expect(await deliverPodHookRelayEvent(event('{"hook_event_name":"Stop"}'))).toBe('spooled')
    expect(runtime.connections).toBe(1)
    expect(existsSync(join(dir, 'spool', 'pane-tab-1_leaf-1.jsonl'))).toBe(true)
  })
})

describe('pod-hook-relay delivery, endpoint file', () => {
  it('follows the file when a restarted runtime rewrites it in place', async () => {
    const before = await fakeRuntime()
    writeEndpoint(before.port)
    await deliverPodHookRelayEvent(event('{"hook_event_name":"PreToolUse"}'))
    const after = await fakeRuntime()
    writeEndpoint(after.port)
    await deliverPodHookRelayEvent(event('{"hook_event_name":"PostToolUse"}'))
    expect(before.bodies).toEqual(['{"hook_event_name":"PreToolUse"}'])
    expect(after.bodies).toEqual(['{"hook_event_name":"PostToolUse"}'])
  })

  it('reads the file again after a failed delivery, even when it looks unchanged', async () => {
    const runtime = await fakeRuntime()
    const dead = await fakeRuntime()
    await new Promise((resolve) => servers.pop()?.close(resolve))
    const sameStamp = (port: number): void => {
      writeEndpoint(port)
      utimesSync(join(dir, 'endpoint.env'), 1_700_000_000, 1_700_000_000)
    }
    // Same inode, size and mtime: only the failure tells the relay its copy is stale.
    expect(String(dead.port).length).toBe(String(runtime.port).length)
    sameStamp(dead.port)
    expect(await deliverPodHookRelayEvent(event('{"hook_event_name":"Stop"}'))).toBe('spooled')
    sameStamp(runtime.port)
    expect(await deliverPodHookRelayEvent(event('{"hook_event_name":"Stop"}'))).toBe('delivered')
    expect(runtime.bodies).toHaveLength(1)
  })
})
