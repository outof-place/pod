// The relay log must never carry what passes through the relay: no header, body, query, token or
// key material, in any encoding. Every request below carries secrets; no event may hold one.
import { createSecureServer } from 'node:http2'
import { request } from 'node:https'
import { connect, createServer, type AddressInfo, type Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { PodOrbstackEvent } from '../../../shared/pod-orbstack-types'
import { createAnthropicRoute } from './pod-orbstack-anthropic-route'
import { createPodOrbstackEvents } from './pod-orbstack-events'
import { RELAY_FRAME } from './pod-orbstack-relay-agent'
import { hookConnection } from './pod-orbstack-relay-connections'
import { createSandboxCa } from './pod-orbstack-sandbox-ca'

const SANDBOX_TOKEN = 'sandbox-hook-token-SECRET-7f3a9c'
const SERVER_TOKEN = 'server-hook-token-SECRET-1b2c3d'
const SECRETS = [
  SANDBOX_TOKEN,
  SERVER_TOKEN,
  'Bearer sk-ant-oat01-AUTHSECRET-0123456789',
  'sk-ant-api03-APIKEYSECRET-abcdef',
  'sessionKey=sk-ant-sid01-COOKIESECRET',
  'BODYSECRET-9f8e7d6c',
  'QUERYSECRET-55aa66bb'
]

/** Every form a secret could hide in: as is, base64, base64url and hex. */
function encodings(secret: string): string[] {
  const bytes = Buffer.from(secret)
  return [secret, bytes.toString('base64'), bytes.toString('base64url'), bytes.toString('hex')]
}

async function listen(server: Pick<Server, 'listen' | 'address'>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address: AddressInfo | string | null = server.address()
  return typeof address === 'object' && address ? address.port : 0
}

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))

/** One VM connection through the hook route; resolves when the relay recorded it. */
function hookPost(raw: string, port: number, onRow: Parameters<typeof hookConnection>[5]) {
  return new Promise<void>((resolve) => {
    const route = {
      vmPort: port,
      hostPort: port,
      hookToken: SERVER_TOKEN,
      authorize: (token: string) => token === SANDBOX_TOKEN
    }
    const connection = hookConnection(
      1,
      route,
      () => true,
      (target) => connect({ host: '127.0.0.1', port: target }),
      () => undefined,
      (row) => {
        onRow?.(row)
        resolve()
      }
    )
    connection.data(Buffer.from(raw))
    connection.end()
    // A refused connection ends when the VM closes its side.
    setTimeout(() => connection.close(), 100)
  })
}

describe('relay log redaction', () => {
  it('keeps every secret out of the relay events and the ring', async () => {
    const events = createPodOrbstackEvents()
    const seen: PodOrbstackEvent[] = []
    const { stop } = events.subscribe((event) => seen.push(event))
    cleanups.push(stop)

    // A hook server that echoes the request back, secrets included.
    const hookServer = createServer((socket) =>
      socket.on('data', (data: Buffer) => {
        socket.end(
          Buffer.concat([Buffer.from('HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n'), data])
        )
      })
    )
    const hookPort = await listen(hookServer)
    cleanups.push(() => hookServer.close())
    const record = (row: Parameters<NonNullable<Parameters<typeof hookConnection>[5]>>[0]) =>
      events.relay({ machine: 'pod-x-sbx', route: 'hook', ...row })
    const body =
      '{"session":"BODYSECRET-9f8e7d6c","auth":"Bearer sk-ant-oat01-AUTHSECRET-0123456789"}'
    const head = (line: string, token: string) =>
      [
        line,
        `X-Orca-Agent-Hook-Token: ${token}`,
        'Authorization: Bearer sk-ant-oat01-AUTHSECRET-0123456789',
        'Cookie: sessionKey=sk-ant-sid01-COOKIESECRET',
        `Content-Length: ${body.length}`,
        '',
        body
      ].join('\r\n')
    await hookPost(head('POST /hook/claude HTTP/1.1', SANDBOX_TOKEN), hookPort, record)
    await hookPost(head('POST /hook/claude HTTP/1.1', SERVER_TOKEN), hookPort, record)
    await hookPost(
      head('POST /hook/claude?key=QUERYSECRET-55aa66bb HTTP/1.1', SANDBOX_TOKEN),
      hookPort,
      record
    )
    await hookPost(head(`POST /${SANDBOX_TOKEN} HTTP/1.1`, SANDBOX_TOKEN), hookPort, record)

    // The anthropic-api route, over the sandbox's TLS, to a stub API that echoes too.
    const upstreamCa = createSandboxCa('stub-upstream')
    const upstream = createSecureServer(
      { allowHTTP1: true, key: upstreamCa.leafKeyPem, cert: upstreamCa.leafCertPem },
      (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        req.pipe(res)
      }
    )
    const upstreamPort = await listen(upstream)
    const ca = createSandboxCa('pod-x-sbx')
    const route = createAnthropicRoute({
      machine: 'pod-x-sbx',
      ca,
      credentials: () => ({
        mode: () => 'api-key',
        authHeaders: async () => ({ 'x-api-key': 'sk-ant-api03-APIKEYSECRET-abcdef' })
      }),
      upstream: { host: '127.0.0.1', port: upstreamPort, ca: upstreamCa.caCertPem },
      onRow: (row) => events.relay({ machine: 'pod-x-sbx', route: 'anthropic-api', ...row })
    })
    const front = createServer((socket) => route.attach(socket))
    const frontPort = await listen(front)
    cleanups.push(() => {
      route.close()
      front.close()
      upstream.close()
    })
    const api = (method: string, path: string) =>
      new Promise<number>((resolve, reject) => {
        const req = request(
          {
            host: '127.0.0.1',
            port: frontPort,
            servername: 'api.anthropic.com',
            ca: ca.caCertPem,
            method,
            path,
            headers: {
              authorization: 'Bearer sk-ant-oat01-AUTHSECRET-0123456789',
              'x-api-key': 'sk-ant-api03-APIKEYSECRET-abcdef',
              cookie: 'sessionKey=sk-ant-sid01-COOKIESECRET',
              'content-type': 'application/json'
            }
          },
          (res) => {
            res.resume()
            res.on('end', () => resolve(res.statusCode ?? 0))
          }
        )
        req.on('error', reject)
        req.end(method === 'POST' ? body : undefined)
      })
    expect(await api('POST', '/v1/messages?key=QUERYSECRET-55aa66bb')).toBe(200)
    expect(await api('POST', `/v1/files/${SANDBOX_TOKEN}?key=QUERYSECRET-55aa66bb`)).toBe(403)
    await new Promise((resolve) => setTimeout(resolve, 400))

    const rows = [...events.subscribe(() => undefined).seed]
    expect(rows.map((row) => [row.route, row.method, row.path, row.status, row.refused])).toEqual([
      ['hook', 'POST', '/hook/claude', 200, null],
      ['hook', 'POST', '/hook/claude', 403, 'token'],
      ['hook', 'POST', '-', 403, 'path'],
      ['hook', 'POST', '-', 403, 'path'],
      ['anthropic-api', 'POST', '/v1/messages', 200, null],
      ['anthropic-api', 'POST', '-', 403, 'path']
    ])
    expect(rows[0]?.bytesUp).toBeGreaterThan(body.length)
    expect(rows[4]?.bytesDown).toBe(body.length)

    const logged = JSON.stringify({ seen, rows })
    const keyMaterial = [ca.caCertPem, ca.leafCertPem, ca.leafKeyPem].flatMap((pem) =>
      pem
        .split('\n')
        .filter((line) => line.length >= 32 && !line.startsWith('-----'))
        .map((line) => line.slice(0, 32))
    )
    for (const secret of SECRETS.flatMap(encodings)) {
      expect(logged).not.toContain(secret)
    }
    for (const chunk of keyMaterial) {
      expect(logged).not.toContain(chunk)
    }
    expect(seen.some((event) => event.type === 'relay')).toBe(true)
    expect(RELAY_FRAME.data).toBe(2)
  })
})
