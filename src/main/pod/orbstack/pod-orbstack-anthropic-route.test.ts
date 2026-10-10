import { constants, createSecureServer, type Http2ServerResponse } from 'node:http2'
import { request } from 'node:https'
import type { IncomingHttpHeaders } from 'node:http'
import { createServer, type AddressInfo, type Server } from 'node:net'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createAnthropicRoute,
  SandboxCredentialError,
  type SandboxAnthropicCredentials
} from './pod-orbstack-anthropic-route'
import type { SandboxPrivacy } from './pod-orbstack-privacy-env'
import { createSandboxCa } from './pod-orbstack-sandbox-ca'

type Seen = { method?: string; url?: string; headers: IncomingHttpHeaders; body: Buffer }

const apiKey: SandboxAnthropicCredentials = {
  mode: () => 'api-key',
  authHeaders: async () => ({ 'x-api-key': 'stub-key-not-a-secret' })
}

async function listen(server: Pick<Server, 'listen' | 'address'>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address: AddressInfo | string | null = server.address()
  return typeof address === 'object' && address ? address.port : 0
}

describe('anthropic-api route', () => {
  const cleanups: (() => void)[] = []
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup()
    }
  })

  async function setup(
    credentials: SandboxAnthropicCredentials = apiKey,
    privacy: SandboxPrivacy = { env: {}, telemetryOff: false, featureFlagsOff: false },
    respond?: (res: Http2ServerResponse) => void
  ) {
    // The stub API has its own CA, so the route verifies upstream as it would the real one.
    const upstreamCa = createSandboxCa('stub-upstream')
    const seen: Seen[] = []
    const upstream = createSecureServer(
      { allowHTTP1: true, key: upstreamCa.leafKeyPem, cert: upstreamCa.leafCertPem },
      (req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        req.on('end', () => {
          seen.push({
            method: req.method,
            url: req.url,
            headers: req.headers,
            body: Buffer.concat(chunks)
          })
          if (respond) {
            respond(res)
            return
          }
          res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_stub' })
          res.write('event: message_start\ndata: {}\n\n')
          setTimeout(() => res.end('event: message_stop\ndata: {}\n\n'), 50)
        })
      }
    )
    const upstreamPort = await listen(upstream)
    const ca = createSandboxCa('pod-x-sbx')
    const refused: string[] = []
    const route = createAnthropicRoute({
      machine: 'pod-x-sbx',
      ca,
      credentials: () => credentials,
      upstream: { host: '127.0.0.1', port: upstreamPort, ca: upstreamCa.caCertPem },
      privacy: () => privacy,
      log: (message) => refused.push(message)
    })
    // Stands in for the relay: each TCP connection is one VM connection to 127.0.0.1:443.
    const front = createServer((socket) => route.attach(socket))
    const port = await listen(front)
    cleanups.push(() => {
      route.close()
      front.close()
      upstream.close()
    })

    const call = (options: {
      method?: string
      path?: string
      servername?: string
      headers?: Record<string, string>
      body?: Buffer
    }) =>
      new Promise<{
        status: number
        body: string
        firstChunkBeforeEnd: boolean
        headers: IncomingHttpHeaders
      }>((resolve, reject) => {
        const req = request(
          {
            host: '127.0.0.1',
            port,
            servername: options.servername ?? 'api.anthropic.com',
            ca: ca.caCertPem,
            method: options.method ?? 'POST',
            path: options.path ?? '/v1/messages?beta=true',
            headers: options.headers ?? {}
          },
          (res) => {
            const chunks: Buffer[] = []
            let firstAt = 0
            res.on('data', (chunk: Buffer) => {
              firstAt ||= Date.now()
              chunks.push(chunk)
            })
            res.on('end', () =>
              resolve({
                status: res.statusCode ?? 0,
                body: Buffer.concat(chunks).toString(),
                firstChunkBeforeEnd: firstAt > 0 && Date.now() - firstAt >= 30,
                headers: res.headers
              })
            )
          }
        )
        req.on('error', reject)
        req.end(options.body)
      })
    return { call, seen, refused }
  }

  it('swaps the VM auth for the credential and streams the answer back', async () => {
    const { call, seen } = await setup()
    const body = gzipSync(Buffer.from('{"model":"claude","stream":true}'))
    const reply = await call({
      headers: {
        'x-api-key': 'pod-sandbox-placeholder',
        authorization: 'Bearer from-the-vm',
        cookie: 'session=vm',
        'proxy-authorization': 'Basic vm',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'fine-grained-tool-streaming-2025-05-14',
        'content-encoding': 'gzip',
        'content-type': 'application/json',
        'content-length': String(body.length)
      },
      body
    })
    expect(reply.status).toBe(200)
    expect(reply.headers['request-id']).toBe('req_stub')
    expect(reply.body).toContain('message_start')
    expect(reply.body).toContain('message_stop')
    expect(reply.firstChunkBeforeEnd).toBe(true)
    const [upstream] = seen
    expect(upstream?.url).toBe('/v1/messages?beta=true')
    expect(upstream?.headers).toMatchObject({
      ':authority': 'api.anthropic.com',
      'x-api-key': 'stub-key-not-a-secret',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'fine-grained-tool-streaming-2025-05-14',
      'content-encoding': 'gzip'
    })
    expect(upstream?.headers.authorization).toBeUndefined()
    expect(upstream?.headers.cookie).toBeUndefined()
    expect(upstream?.headers['proxy-authorization']).toBeUndefined()
    expect(upstream?.body.equals(body)).toBe(true)
  })

  it('refuses anything Claude Code does not need, without reaching the API', async () => {
    const { call, seen, refused } = await setup()
    expect((await call({ path: '/v1/organizations/keys' })).status).toBe(403)
    expect((await call({ method: 'DELETE', path: '/v1/messages' })).status).toBe(403)
    expect((await call({ method: 'GET', path: '/api/oauth/profile' })).status).toBe(403)
    // Dot segments or escapes could resolve past the rules upstream.
    for (const path of [
      '/api/claude_code/../../v1/organizations/keys',
      '/api/claude_code/%2e%2e/%2e%2e/v1/files',
      '/api/claude_code//settings'
    ]) {
      expect((await call({ method: 'GET', path })).status, path).toBe(403)
    }
    expect(seen).toEqual([])
    expect(refused).toContain('refused GET /api/oauth/profile')
  })

  it('forwards telemetry and flag fetches while the Mac allows them', async () => {
    const { call, seen } = await setup()
    expect((await call({ path: '/api/event_logging/v2/batch' })).status).toBe(200)
    expect((await call({ path: '/api/eval/sdk-abc' })).status).toBe(200)
    expect(seen.map((request) => request.url)).toEqual([
      '/api/event_logging/v2/batch',
      '/api/eval/sdk-abc'
    ])
  })

  it('refuses telemetry and flag fetches for a sandbox whose Mac turned them off', async () => {
    const { call, seen } = await setup(apiKey, {
      env: { DISABLE_TELEMETRY: '1' },
      telemetryOff: true,
      featureFlagsOff: true
    })
    expect((await call({ path: '/api/event_logging/v2/batch' })).status).toBe(403)
    expect((await call({ path: '/api/eval/sdk-abc' })).status).toBe(403)
    expect((await call({})).status).toBe(200)
    expect(seen.map((request) => request.url)).toEqual(['/v1/messages?beta=true'])
  })

  it('answers 401 while the credential source has nothing for this sandbox', async () => {
    const { call, seen } = await setup({ mode: () => 'api-key', authHeaders: async () => null })
    expect((await call({})).status).toBe(401)
    expect(seen).toEqual([])
  })

  it("refuses with the credential source's own message, never reaching the API", async () => {
    const { call, seen } = await setup({
      mode: () => 'oauth',
      authHeaders: async () => {
        throw new SandboxCredentialError('The Claude Code login on this Mac has expired.')
      }
    })
    const reply = await call({})
    expect(reply.status).toBe(401)
    expect(JSON.parse(reply.body).error.message).toBe(
      'The Claude Code login on this Mac has expired.'
    )
    expect(seen).toEqual([])
  })

  it('tells the credential source when the API refuses its token', async () => {
    const rejected = vi.fn()
    const { call } = await setup({ ...apiKey, rejected }, undefined, (res) => {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end('{"type":"error","error":{"type":"authentication_error","message":"expired"}}')
    })
    expect((await call({})).status).toBe(401)
    expect(rejected).toHaveBeenCalledWith({ machine: 'pod-x-sbx' })
  })

  it('ends the sandbox response when the API breaks off mid-stream', async () => {
    const { call } = await setup(apiKey, undefined, (res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('event: message_start\ndata: {}\n\n')
      setTimeout(() => res.stream.close(constants.NGHTTP2_INTERNAL_ERROR), 20)
    })
    // Settles (either way) instead of hanging the VM's connection.
    await call({}).then(
      () => undefined,
      () => undefined
    )
  })

  it('refuses a TLS handshake for any other name', async () => {
    const { call } = await setup()
    await expect(call({ servername: 'evil.example' })).rejects.toThrow()
  })
})
