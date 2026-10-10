import { execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, request, type IncomingHttpHeaders } from 'node:http'
import { createSecureServer } from 'node:http2'
import { request as httpsRequest } from 'node:https'
import { connect, createServer, type AddressInfo, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { spawnProcess } from '../../../shared/child-process/run-process'
import { createAnthropicRoute } from './pod-orbstack-anthropic-route'
import { RELAY_FRAME } from './pod-orbstack-relay-agent'
import { createSandboxCa } from './pod-orbstack-sandbox-ca'
import {
  buildRelayWait,
  createSandboxRelays,
  decodeRelayFrames,
  encodeRelayFrame,
  type SandboxHookRoute
} from './pod-orbstack-relay'

function hasPython(): boolean {
  try {
    execFileSync('python3', ['-I', '-c', 'pass'])
    return true
  } catch {
    return false
  }
}

async function listen(server: Pick<Server, 'listen' | 'address'>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address: AddressInfo | string | null = server.address()
  return typeof address === 'object' && address ? address.port : 0
}

async function freePort(): Promise<number> {
  const server = createServer()
  const port = await listen(server)
  await new Promise((resolve) => server.close(resolve))
  return port
}

type Reply = { status: number; body: string }

function post(
  port: number,
  options: { method?: string; path?: string; token?: string; body?: Buffer; expect?: boolean }
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const body = options.body ?? Buffer.from('{"hook_event_name":"Stop"}')
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'POST',
        path: options.path ?? '/hook/claude',
        agent: false,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
          'X-Orca-Agent-Hook-Token': options.token ?? 'sandbox-token',
          ...(options.expect ? { Expect: '100-continue' } : {})
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() })
        )
      }
    )
    req.on('error', reject)
    if (options.expect) {
      req.on('continue', () => req.end(body))
    } else {
      req.end(body)
    }
  })
}

describe('relay frames', () => {
  it('round-trips frames split at any byte', () => {
    const bytes = Buffer.concat([
      encodeRelayFrame(RELAY_FRAME.open, 7, Buffer.from([1])),
      encodeRelayFrame(RELAY_FRAME.data, 7, Buffer.from('hello')),
      encodeRelayFrame(RELAY_FRAME.end, 7)
    ])
    for (let split = 0; split <= bytes.length; split += 1) {
      const frames: [number, number, string][] = []
      const collect = (kind: number, conn: number, payload: Buffer) =>
        frames.push([kind, conn, payload.toString('hex')])
      const rest = decodeRelayFrames(bytes.subarray(0, split), collect)
      expect(decodeRelayFrames(Buffer.concat([rest, bytes.subarray(split)]), collect)).toHaveLength(
        0
      )
      expect(frames).toEqual([
        [RELAY_FRAME.open, 7, '01'],
        [RELAY_FRAME.data, 7, Buffer.from('hello').toString('hex')],
        [RELAY_FRAME.end, 7, '']
      ])
    }
  })

  it('waits for this relay by nonce, then gives up', () => {
    expect(buildRelayWait('abc123', '/run/x')).toBe(
      'w=0; until [ "$(cat /run/x/ready 2>/dev/null)" = abc123 ] || [ $w -ge 150 ]; do sleep 0.1; w=$((w+1)); done;'
    )
  })
})

describe('host side', () => {
  it('opens nothing for a route the VM invents', async () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const fake = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr: new PassThrough(),
      kill: () => true
    })
    const dialed: number[] = []
    const relays = createSandboxRelays({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the relay touches only stdin/stdout/stderr, kill and events, all present on the fake.
      spawnAgent: () => fake as unknown as ChildProcessWithoutNullStreams,
      connectHost: (port) => {
        dialed.push(port)
        return connect({ host: '127.0.0.1', port })
      }
    })
    relays.ensure('pod-x-sbx', {
      hook: { vmPort: 1, hostPort: 1, hookToken: 'server-token', authorize: () => true },
      anthropic: null
    })
    const replies: number[][] = []
    stdin.on('data', (chunk: Buffer) => {
      decodeRelayFrames(chunk, (kind, conn) => replies.push([kind, conn]))
    })
    stdout.write(encodeRelayFrame(RELAY_FRAME.open, 9, Buffer.from([4])))
    // The anthropic-api route is off: its index is refused like any other.
    stdout.write(encodeRelayFrame(RELAY_FRAME.open, 10, Buffer.from([1])))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(dialed).toEqual([])
    expect(replies).toEqual([
      [RELAY_FRAME.close, 9],
      [RELAY_FRAME.close, 10]
    ])
  })
})

describe.skipIf(process.platform === 'win32' || !hasPython())('relay agent over stdio', () => {
  const cleanups: (() => void)[] = []
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup()
    }
  })

  async function setup() {
    const stateDir = mkdtempSync(join(tmpdir(), 'pod-relay-'))
    const seen: { method?: string; url?: string; headers: IncomingHttpHeaders; body: string }[] = []
    const hookServer = createHttpServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        seen.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString()
        })
        res.end('ok')
      })
    })
    const hostPort = await listen(hookServer)
    const vmPort = await freePort()
    const route: SandboxHookRoute = {
      vmPort,
      hostPort,
      hookToken: 'server-token',
      authorize: (token) => token === 'sandbox-token'
    }
    // Stand-ins for the VM's /etc/hosts and CA path.
    const hostsFile = join(stateDir, 'hosts')
    writeFileSync(hostsFile, '127.0.0.1 localhost\n')
    const caPath = join(stateDir, 'pod-sandbox', 'anthropic-ca.pem')
    const relays = createSandboxRelays({
      stateDir,
      hostsFile,
      caPath,
      spawnAgent: (_machine, args) => spawnProcess({ program: 'python3', args })
    })
    cleanups.push(() => {
      relays.stopAll()
      hookServer.close()
      rmSync(stateDir, { recursive: true, force: true })
    })
    const hook = (route: SandboxHookRoute) => ({ hook: route, anthropic: null })
    return { relays, route, hook, vmPort, stateDir, seen, hostsFile, caPath }
  }

  it('forwards hook posts with the server token swapped in', async () => {
    const { relays, route, hook, vmPort, stateDir, seen } = await setup()
    const handle = relays.ensure('pod-x-sbx', hook(route))
    expect(await handle.ready).toBe(true)
    expect(readFileSync(join(stateDir, 'ready'), 'utf8')).toBe(handle.nonce)

    const replies = await Promise.all([
      post(vmPort, {}),
      post(vmPort, { body: Buffer.from(`{"big":"${'x'.repeat(200_000)}"}`) }),
      post(vmPort, { expect: true })
    ])
    expect(replies.map((reply) => reply.status)).toEqual([200, 200, 200])
    expect(seen).toHaveLength(3)
    for (const request of seen) {
      expect(request).toMatchObject({ method: 'POST', url: '/hook/claude' })
      expect(request.headers['x-orca-agent-hook-token']).toBe('server-token')
      expect(request.headers.connection).toBe('close')
      expect(request.headers.expect).toBeUndefined()
    }
    expect(seen.map((request) => request.body.length).sort((a, b) => a - b)[2]).toBe(200_010)
  })

  it('answers everything but a token-bearing hook post itself', async () => {
    const { relays, route, hook, vmPort, seen } = await setup()
    expect(await relays.ensure('pod-x-sbx', hook(route)).ready).toBe(true)
    expect((await post(vmPort, { token: 'server-token' })).status).toBe(403)
    expect((await post(vmPort, { path: '/hook/codex' })).status).toBe(403)
    expect((await post(vmPort, { path: '/' })).status).toBe(403)
    expect((await post(vmPort, { method: 'PUT' })).status).toBe(405)
    expect((await post(vmPort, { body: Buffer.alloc(1024 * 1024 + 1, 1) })).status).toBe(413)
    expect(seen).toEqual([])
  })

  it('reuses a live relay for the same hook server and replaces it for another', async () => {
    const { relays, route, hook, vmPort } = await setup()
    const first = relays.ensure('pod-x-sbx', hook(route))
    expect(await first.ready).toBe(true)
    expect(relays.ensure('pod-x-sbx', hook({ ...route, authorize: () => false }))).toBe(first)

    const second = relays.ensure('pod-x-sbx', hook({ ...route, hookToken: 'rotated' }))
    expect(second.nonce).not.toBe(first.nonce)
    expect(await second.ready).toBe(true)
    expect((await post(vmPort, {})).status).toBe(200)
  })

  it('serves api.anthropic.com from the Mac while the anthropic-api route is on, then unpins', async () => {
    const { relays, route, hostsFile, caPath } = await setup()
    const upstreamCa = createSandboxCa('stub-upstream')
    const keys: (string | string[] | undefined)[] = []
    const upstream = createSecureServer(
      { allowHTTP1: true, key: upstreamCa.leafKeyPem, cert: upstreamCa.leafCertPem },
      (req, res) => {
        keys.push(req.headers['x-api-key'])
        req.resume()
        req.on('end', () => res.end('{"type":"message"}'))
      }
    )
    const upstreamPort = await listen(upstream)
    const ca = createSandboxCa('pod-x-sbx')
    const anthropic = createAnthropicRoute({
      machine: 'pod-x-sbx',
      ca,
      credentials: () => ({
        mode: () => 'api-key',
        authHeaders: async () => ({ 'x-api-key': 'stub-key-not-a-secret' })
      }),
      upstream: { host: '127.0.0.1', port: upstreamPort, ca: upstreamCa.caCertPem }
    })
    cleanups.push(() => {
      anthropic.close()
      upstream.close()
    })
    const apiPort = await freePort()
    const handle = relays.ensure('pod-x-sbx', {
      hook: route,
      anthropic: { route: anthropic, vmPort: apiPort }
    })
    expect(await handle.ready).toBe(true)
    expect(readFileSync(hostsFile, 'utf8')).toBe(
      '127.0.0.1 localhost\n# pod-sandbox-relay begin\n127.0.0.1 api.anthropic.com\n::1 api.anthropic.com\n# pod-sandbox-relay end\n'
    )
    expect(readFileSync(caPath, 'utf8')).toBe(ca.caCertPem)

    const reply = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpsRequest(
        {
          host: '127.0.0.1',
          port: apiPort,
          servername: 'api.anthropic.com',
          ca: readFileSync(caPath, 'utf8'),
          method: 'POST',
          path: '/v1/messages',
          headers: { 'x-api-key': 'pod-sandbox-no-credential', 'content-type': 'application/json' }
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() })
          )
        }
      )
      req.on('error', reject)
      req.end('{}')
    })
    expect(reply).toEqual({ status: 200, body: '{"type":"message"}' })
    expect(keys).toEqual(['stub-key-not-a-secret'])

    relays.stop('pod-x-sbx')
    await expect
      .poll(() => readFileSync(hostsFile, 'utf8'), { timeout: 5_000 })
      .toBe('127.0.0.1 localhost\n')
    expect(existsSync(caPath)).toBe(false)
  })
})
