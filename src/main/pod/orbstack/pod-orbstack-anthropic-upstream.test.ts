import { createSecureServer, type IncomingHttpHeaders, type ServerHttp2Stream } from 'node:http2'
import { createServer as createHttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { gunzipSync, gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'

function portOf(server: { address(): AddressInfo | string | null }): number {
  const address = server.address()
  return typeof address === 'object' && address ? address.port : 0
}
import {
  createAnthropicUpstream,
  type AnthropicUpstreamClient
} from './pod-orbstack-anthropic-upstream'
import { createSandboxCa } from './pod-orbstack-sandbox-ca'

type Seen = { headers: IncomingHttpHeaders; body: Buffer; session: unknown }

const SECRET = 'Bearer fake-oauth-token-for-tests'
const ca = createSandboxCa('stub-upstream')

async function readAll(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  }
  return Buffer.concat(chunks)
}

describe('anthropic upstream client', () => {
  const cleanups: (() => void)[] = []
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup()
    }
  })

  async function setup(
    respond: (stream: ServerHttp2Stream, seen: Seen) => void = (stream) => {
      stream.respond({ ':status': 200, 'content-type': 'application/json' })
      stream.end('{"ok":true}')
    }
  ) {
    const seen: Seen[] = []
    const server = createSecureServer({ key: ca.leafKeyPem, cert: ca.leafCertPem })
    // Why per session: the server-level 'stream' event is typed as a plain Http2Stream.
    server.on('session', (session) =>
      session.on('stream', (stream, headers) => {
        const chunks: Buffer[] = []
        stream.on('data', (chunk: Buffer) => chunks.push(chunk))
        stream.on('end', () => {
          const entry = { headers, body: Buffer.concat(chunks), session }
          seen.push(entry)
          respond(stream, entry)
        })
      })
    )
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = portOf(server)
    const logs: string[] = []
    const client = createAnthropicUpstream({
      target: { host: '127.0.0.1', port, ca: ca.caCertPem },
      log: (message) => logs.push(message)
    })
    cleanups.push(() => {
      client.close()
      server.close()
    })
    return { client, seen, logs, port }
  }

  const call = (
    client: AnthropicUpstreamClient,
    init: { method?: string; path?: string; headers?: Record<string, string>; body?: Buffer } = {}
  ) =>
    client.request({
      method: init.method ?? 'POST',
      path: init.path ?? '/v1/messages?beta=true',
      headers: init.headers ?? {},
      body: Readable.from(init.body ? [init.body] : []),
      signal: new AbortController().signal
    })

  it('sends the request as api.anthropic.com over a verified HTTP/2 session', async () => {
    const { client, seen } = await setup()
    const res = await call(client, {
      headers: {
        authorization: SECRET,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
        connection: 'keep-alive',
        host: '127.0.0.1',
        'content-type': 'application/json',
        'content-length': '13'
      },
      body: Buffer.from('{"model":"m"}')
    })
    expect(res.status).toBe(200)
    expect((await readAll(res.body)).toString()).toBe('{"ok":true}')
    const [request] = seen
    expect(request.headers[':authority']).toBe('api.anthropic.com')
    expect(request.headers[':path']).toBe('/v1/messages?beta=true')
    expect(request.headers.authorization).toBe(SECRET)
    expect(request.headers['anthropic-beta']).toBe('claude-code-20250219,oauth-2025-04-20')
    expect(request.headers.connection).toBeUndefined()
    // A body under the gzip floor goes as it came.
    expect(request.headers['content-encoding']).toBeUndefined()
    expect(request.body.toString()).toBe('{"model":"m"}')
  })

  it('refuses an upstream it cannot verify', async () => {
    const { port } = await setup()
    const untrusted = createAnthropicUpstream({ target: { host: '127.0.0.1', port } })
    cleanups.push(() => untrusted.close())
    await expect(call(untrusted)).rejects.toThrow()
  })

  it('gzips a large identity Messages body and leaves encoded or other bodies alone', async () => {
    const { client, seen } = await setup()
    const big = Buffer.from(JSON.stringify({ messages: 'x'.repeat(4096) }))
    await readAll((await call(client, { body: big })).body)
    const encoded = gzipSync(big)
    await readAll(
      (await call(client, { headers: { 'content-encoding': 'gzip' }, body: encoded })).body
    )
    await readAll((await call(client, { path: '/api/event_logging/v2/batch', body: big })).body)
    expect(seen[0].headers['content-encoding']).toBe('gzip')
    expect(gunzipSync(seen[0].body).equals(big)).toBe(true)
    expect(seen[1].body.equals(encoded)).toBe(true)
    expect(seen[2].headers['content-encoding']).toBeUndefined()
    expect(seen[2].body.equals(big)).toBe(true)
  })

  it('streams the response as it arrives and passes encoded bytes through untouched', async () => {
    const brotli = Buffer.from([0x1b, 0x03, 0x00, 0xf8, 0xa5, 0x40, 0x42])
    let release: () => void = () => {}
    const { client } = await setup((stream) => {
      stream.respond({
        ':status': 200,
        'content-type': 'text/event-stream',
        'content-encoding': 'br',
        'set-cookie': ['a=1', 'b=2']
      })
      stream.write(brotli)
      release = () => stream.end(brotli)
    })
    const res = await call(client)
    expect(res.headers).toEqual(
      expect.arrayContaining(['content-encoding', 'br', 'set-cookie', 'a=1', 'set-cookie', 'b=2'])
    )
    const first: Buffer = await new Promise((resolve) => res.body.once('data', resolve))
    expect(first.equals(brotli)).toBe(true)
    release()
    expect((await readAll(res.body)).equals(brotli)).toBe(true)
  })

  it('passes error statuses and retry headers through', async () => {
    const { client } = await setup((stream) => {
      stream.respond({ ':status': 529, 'retry-after': '7', 'x-should-retry': 'true' })
      stream.end('{"type":"error","error":{"type":"overloaded_error","message":"busy"}}')
    })
    const res = await call(client)
    expect(res.status).toBe(529)
    expect(res.headers).toEqual(expect.arrayContaining(['retry-after', '7']))
    expect(JSON.parse((await readAll(res.body)).toString()).error.type).toBe('overloaded_error')
  })

  it('shares one session across requests', async () => {
    const { client, seen } = await setup()
    await Promise.all([1, 2, 3].map(async () => readAll((await call(client)).body)))
    await readAll((await call(client)).body)
    expect(new Set(seen.map((entry) => entry.session)).size).toBe(1)
  })

  it('cancels the upstream stream when the sandbox side goes away', async () => {
    let upstreamClosed: Promise<void> = Promise.resolve()
    const { client } = await setup((stream) => {
      upstreamClosed = new Promise((resolve) => stream.once('close', () => resolve()))
      stream.respond({ ':status': 200, 'content-type': 'text/event-stream' })
      stream.write('event: ping\n\n')
    })
    const controller = new AbortController()
    const res = await client.request({
      method: 'POST',
      path: '/v1/messages',
      headers: {},
      body: Readable.from([]),
      signal: controller.signal
    })
    await new Promise((resolve) => res.body.once('data', resolve))
    controller.abort()
    await upstreamClosed
  })

  it('refuses an upstream that does not speak HTTP/2', async () => {
    const server = createHttpsServer({ key: ca.leafKeyPem, cert: ca.leafCertPem }, (_req, res) =>
      res.end('h1')
    )
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const client = createAnthropicUpstream({
      target: { host: '127.0.0.1', port: portOf(server), ca: ca.caCertPem }
    })
    cleanups.push(() => {
      client.close()
      server.close()
    })
    await expect(call(client)).rejects.toThrow()
  })

  it('never puts a header value, such as the credential, into an error or a log line', async () => {
    const { client, logs } = await setup()
    const bad = `${SECRET}\r\nx-injected: 1`
    const failure = await call(client, { headers: { authorization: bad } }).catch(
      (error: unknown) => error
    )
    expect(failure).toBeInstanceOf(Error)
    expect(failure instanceof Error ? failure.message : '').not.toContain('fake-oauth-token')
    expect(logs.join('\n')).not.toContain('fake-oauth-token')
  })
})
