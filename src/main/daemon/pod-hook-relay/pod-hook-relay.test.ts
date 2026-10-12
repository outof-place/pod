import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  deliverPodHookRelayEvent,
  type PodHookRelayEvent,
  type PodHookRelayPane
} from './pod-hook-relay-delivery'
import {
  PodHookRelay,
  POD_HOOK_RELAY_PANE_HEADER,
  POD_HOOK_RELAY_TOKEN_HEADER
} from './pod-hook-relay-server'

let dir = ''
const servers: Server[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pod-hook-relay-'))
})

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))))
  rmSync(dir, { recursive: true, force: true })
})

function pane(overrides: Partial<PodHookRelayPane> = {}): PodHookRelayPane {
  return {
    paneKey: 'tab-1:leaf-1',
    tabId: 'tab-1',
    launchToken: 'launch-1',
    worktreeId: 'repo::/w',
    env: 'production',
    version: '1',
    endpoint: join(dir, 'endpoint.env'),
    ...overrides
  }
}

function encodePane(value: PodHookRelayPane): string {
  const fields = [
    value.paneKey,
    value.tabId,
    value.launchToken,
    value.worktreeId,
    value.env,
    value.version,
    value.endpoint
  ]
  return Buffer.from(fields.join('\x1f')).toString('base64')
}

type Captured = { url: string; headers: IncomingHttpHeaders; body: string }

async function fakeRuntime(transport = 'raw-json-v1'): Promise<Captured[]> {
  const captured: Captured[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      captured.push({
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString()
      })
      res.end('ok')
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = address && typeof address === 'object' ? address.port : 0
  writeFileSync(
    join(dir, 'endpoint.env'),
    `ORCA_AGENT_HOOK_PORT=${port}\nORCA_AGENT_HOOK_TOKEN=runtime-token\nORCA_AGENT_HOOK_ENV=production\nORCA_AGENT_HOOK_VERSION=1\nORCA_AGENT_HOOK_TRANSPORT=${transport}\n`
  )
  return captured
}

function event(payload: string, overrides: Partial<PodHookRelayEvent> = {}): PodHookRelayEvent {
  return {
    agent: 'claude',
    pane: pane(),
    agentProcess: '{"pid":42,"platform":"darwin","startTime":"Mon Oct 12 03:00:00 2026"}',
    payload: Buffer.from(payload),
    ...overrides
  }
}

describe('pod-hook-relay delivery', () => {
  it("sends the runtime the command hook's request, read from the endpoint file", async () => {
    const captured = await fakeRuntime()
    const outcome = await deliverPodHookRelayEvent(event('{"hook_event_name":"Stop"}'))
    expect(outcome).toBe('delivered')
    expect(captured).toHaveLength(1)
    const [sent] = captured
    expect(sent.url).toBe('/hook/claude')
    expect(sent.body).toBe('{"hook_event_name":"Stop"}')
    expect(sent.headers['content-type']).toBe('application/json')
    expect(sent.headers['x-orca-agent-hook-token']).toBe('runtime-token')
    expect(sent.headers['x-orca-agent-hook-meta-encoding']).toBe('base64')
    expect(Buffer.from(String(sent.headers['x-orca-agent-hook-meta']), 'base64').toString()).toBe(
      'tab-1:leaf-1\x1ftab-1\x1flaunch-1\x1frepo::/w\x1fproduction\x1f1'
    )
    expect(sent.headers['x-orca-agent-process']).toBe(
      '{"pid":42,"platform":"darwin","startTime":"Mon Oct 12 03:00:00 2026"}'
    )
  })

  it('encodes a form body as the C client does when the runtime asks for it', async () => {
    const captured = await fakeRuntime('')
    await deliverPodHookRelayEvent(event('{"a":"b c"}'))
    expect(captured[0].headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(captured[0].body).toContain('&payload=%7B%22a%22%3A%22b%20c%22%7D')
    expect(captured[0].body.startsWith('paneKey=tab-1%3Aleaf-1&tabId=tab-1&')).toBe(true)
  })

  it('spools a lifecycle event the runtime missed, never a tool event', async () => {
    writeFileSync(join(dir, 'endpoint.env'), 'ORCA_AGENT_HOOK_PORT=1\nORCA_AGENT_HOOK_TOKEN=t\n')
    const now = () => Date.parse('2026-10-12T03:00:00.500Z')
    expect(await deliverPodHookRelayEvent(event('{"hook_event_name":"Stop"}'), now)).toBe('spooled')
    await deliverPodHookRelayEvent(event('{"hook_event_name":"PreToolUse"}'), now)
    const file = join(dir, 'spool', 'pane-tab-1_leaf-1.jsonl')
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0])).toEqual({
      paneKey: 'tab-1:leaf-1',
      tabId: 'tab-1',
      worktreeId: 'repo::/w',
      env: 'production',
      version: '1',
      launchToken: 'launch-1',
      source: 'claude',
      receivedAt: Date.parse('2026-10-12T03:00:00.000Z'),
      agentProcess: '{"pid":42,"platform":"darwin","startTime":"Mon Oct 12 03:00:00 2026"}',
      payload: { hook_event_name: 'Stop' }
    })
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })
})

function post(port: number, headers: Record<string, string>, body: string, path = '/hook/claude') {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, method: 'POST', path, headers, agent: false },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() })
        )
      }
    )
    req.on('error', reject)
    req.end(body)
  })
}

describe('pod-hook-relay server', () => {
  async function startRelay(deliver: (event: PodHookRelayEvent) => Promise<unknown>) {
    const relayFilePath = join(dir, 'pod-hook-relay-v1.env')
    const relay = new PodHookRelay({ relayFilePath, log: () => {}, deliver })
    await relay.start()
    const values = Object.fromEntries(
      readFileSync(relayFilePath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => line.split('='))
    )
    return {
      relay,
      relayFilePath,
      port: Number(values.POD_HOOK_RELAY_PORT),
      token: values.POD_HOOK_RELAY_TOKEN
    }
  }

  it('answers at once, before the event reaches the runtime, and keeps a pane in order', async () => {
    const seen: string[] = []
    let release: () => void = () => {}
    const blocked = new Promise<void>((resolve) => (release = resolve))
    const { relay, relayFilePath, port, token } = await startRelay(async (e) => {
      if (e.payload.toString().includes('first')) {
        await blocked
      }
      seen.push(e.payload.toString())
    })
    expect(statSync(relayFilePath).mode & 0o777).toBe(0o600)
    const headers = {
      [POD_HOOK_RELAY_TOKEN_HEADER]: token,
      [POD_HOOK_RELAY_PANE_HEADER]: encodePane(pane()),
      'x-orca-agent-process': '{"pid":42}'
    }
    expect(await post(port, headers, '{"first":1}\n')).toEqual({ status: 200, body: '{}\n' })
    expect(await post(port, headers, '{"second":2}')).toEqual({ status: 200, body: '{}\n' })
    expect(seen).toEqual([])
    release()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(seen).toEqual(['{"first":1}', '{"second":2}'])
    await relay.close()
    expect(existsSync(relayFilePath)).toBe(false)
  })

  it('refuses a request without its token, its pane, or a hook path', async () => {
    const seen: PodHookRelayEvent[] = []
    const { relay, port, token } = await startRelay(async (e) => void seen.push(e))
    const paneHeader = encodePane(pane())
    expect(
      (
        await post(
          port,
          {
            [POD_HOOK_RELAY_TOKEN_HEADER]: 'x'.repeat(token.length),
            [POD_HOOK_RELAY_PANE_HEADER]: paneHeader
          },
          '{}'
        )
      ).status
    ).toBe(403)
    expect((await post(port, { [POD_HOOK_RELAY_TOKEN_HEADER]: token }, '{}')).status).toBe(403)
    expect(
      (
        await post(
          port,
          { [POD_HOOK_RELAY_TOKEN_HEADER]: token, [POD_HOOK_RELAY_PANE_HEADER]: paneHeader },
          '{}',
          '/other'
        )
      ).status
    ).toBe(404)
    expect(seen).toEqual([])
    await relay.close()
  })
})
