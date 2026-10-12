import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  existsSync
} from 'node:fs'
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
    expect(captured[0].body).toContain('&payload=%7B%22a%22%3A%22b+c%22%7D')
    expect(captured[0].body.startsWith('paneKey=tab-1%3Aleaf-1&tabId=tab-1&')).toBe(true)
  })

  it('form-encodes a payload of every byte across encoding slices, byte for byte', async () => {
    const captured = await fakeRuntime('')
    const payload = Buffer.alloc(600 * 1024)
    for (let i = 0; i < payload.length; i++) {
      payload[i] = (i * 7) % 256
    }
    await deliverPodHookRelayEvent(event('', { payload }))
    const encoded = captured[0].body.split('&payload=')[1]
    const decoded: number[] = []
    for (let i = 0; i < encoded.length; i++) {
      if (encoded[i] === '%') {
        decoded.push(Number.parseInt(encoded.slice(i + 1, i + 3), 16))
        i += 2
      } else {
        decoded.push(encoded[i] === '+' ? 0x20 : encoded.charCodeAt(i))
      }
    }
    expect(Buffer.from(decoded).equals(payload)).toBe(true)
    expect(Number(captured[0].headers['content-length'])).toBe(Buffer.byteLength(captured[0].body))
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

  it('truncates a spool older than 7 whole days, as the C client counts them', async () => {
    writeFileSync(join(dir, 'endpoint.env'), 'ORCA_AGENT_HOOK_PORT=1\nORCA_AGENT_HOOK_TOKEN=t\n')
    const file = join(dir, 'spool', 'pane-tab-1_leaf-1.jsonl')
    const now = Date.parse('2026-10-12T03:00:00.000Z')
    await deliverPodHookRelayEvent(event('{"hook_event_name":"Stop","n":1}'), () => now)
    // 7.9 days is 7 in integer days: kept.
    utimesSync(file, (now - 7.9 * 86_400_000) / 1000, (now - 7.9 * 86_400_000) / 1000)
    await deliverPodHookRelayEvent(event('{"hook_event_name":"Stop","n":2}'), () => now)
    expect(readFileSync(file, 'utf8').split('\n').filter(Boolean)).toHaveLength(2)
    utimesSync(file, (now - 8 * 86_400_000) / 1000, (now - 8 * 86_400_000) / 1000)
    await deliverPodHookRelayEvent(event('{"hook_event_name":"Stop","n":3}'), () => now)
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    expect(lines.map((line) => JSON.parse(line).payload.n)).toEqual([3])
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
  async function startRelay(
    deliver: (event: PodHookRelayEvent) => Promise<unknown>,
    options: { endpointAllowed?: (endpoint: string) => boolean; logs?: unknown[][] } = {}
  ) {
    const relayFilePath = join(dir, 'pod-hook-relay-v1.env')
    const relay = new PodHookRelay({
      relayFilePath,
      log: (...entry) =>
        void (entry[0] !== 'pod-hook-relay-listening' && options.logs?.push(entry)),
      deliver,
      endpointAllowed: options.endpointAllowed ?? ((endpoint) => endpoint === pane().endpoint)
    })
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

  it('answers but drops an event whose endpoint no daemon session was spawned with', async () => {
    const seen: PodHookRelayEvent[] = []
    const logs: unknown[][] = []
    const { relay, port, token } = await startRelay(async (e) => void seen.push(e), { logs })
    const elsewhere = encodePane(pane({ endpoint: join(dir, 'other', 'endpoint.env') }))
    const headers = {
      [POD_HOOK_RELAY_TOKEN_HEADER]: token,
      [POD_HOOK_RELAY_PANE_HEADER]: elsewhere
    }
    expect(await post(port, headers, '{"hook_event_name":"Stop"}')).toEqual({
      status: 200,
      body: '{}\n'
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(seen).toEqual([])
    expect(existsSync(join(dir, 'other'))).toBe(false)
    expect(logs).toEqual([
      [
        'pod-hook-relay-endpoint-refused',
        { endpoint: join(dir, 'other', 'endpoint.env'), refused: 1 }
      ]
    ])
    await relay.close()
  })

  it('caps a hung pane: lifecycle events go to the spool, tool events are dropped', async () => {
    const seen: string[] = []
    let release: () => void = () => {}
    const blocked = new Promise<void>((resolve) => (release = resolve))
    const logs: unknown[][] = []
    const { relay, port, token } = await startRelay(
      async (e) => {
        await blocked
        seen.push(e.payload.toString())
      },
      { logs }
    )
    const headers = {
      [POD_HOOK_RELAY_TOKEN_HEADER]: token,
      [POD_HOOK_RELAY_PANE_HEADER]: encodePane(pane())
    }
    for (let i = 0; i < 64; i++) {
      await post(port, headers, `{"hook_event_name":"PostToolUse","i":${i}}`)
    }
    await post(port, headers, '{"hook_event_name":"PreToolUse","i":64}')
    await post(port, headers, '{"hook_event_name":"Stop","i":65}')
    const spooled = readFileSync(join(dir, 'spool', 'pane-tab-1_leaf-1.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line).payload)
    expect(spooled).toEqual([{ hook_event_name: 'Stop', i: 65 }])
    release()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(seen).toHaveLength(64)
    expect(logs).toEqual([
      [
        'pod-hook-relay-pane-backlog-full',
        { paneKey: 'tab-1:leaf-1', events: 64, bytes: expect.any(Number) }
      ],
      ['pod-hook-relay-pane-backlog-drained', { paneKey: 'tab-1:leaf-1', spooled: 1, dropped: 1 }]
    ])
    await relay.close()
  })

  it('spools the backlog behind the event in flight when it closes', async () => {
    const { relay, port, token } = await startRelay(() => new Promise(() => {}))
    const headers = {
      [POD_HOOK_RELAY_TOKEN_HEADER]: token,
      [POD_HOOK_RELAY_PANE_HEADER]: encodePane(pane())
    }
    await post(port, headers, '{"hook_event_name":"UserPromptSubmit"}')
    await post(port, headers, '{"hook_event_name":"PreToolUse"}')
    await post(port, headers, '{"hook_event_name":"Stop"}')
    await relay.close()
    const spooled = readFileSync(join(dir, 'spool', 'pane-tab-1_leaf-1.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line).payload)
    expect(spooled).toEqual([{ hook_event_name: 'Stop' }])
  })

  it('logs a payload over 16 MiB with its size', async () => {
    const logs: unknown[][] = []
    const seen: PodHookRelayEvent[] = []
    const { relay, port, token } = await startRelay(async (e) => void seen.push(e), { logs })
    const headers = {
      [POD_HOOK_RELAY_TOKEN_HEADER]: token,
      [POD_HOOK_RELAY_PANE_HEADER]: encodePane(pane())
    }
    const body = 'x'.repeat(16 * 1024 * 1024 + 1)
    expect((await post(port, headers, body)).status).toBe(200)
    expect(seen).toEqual([])
    expect(logs).toEqual([
      ['pod-hook-relay-payload-too-large', { paneKey: 'tab-1:leaf-1', bytes: body.length }]
    ])
    await relay.close()
  })
})
