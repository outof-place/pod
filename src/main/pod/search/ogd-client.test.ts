import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OgdClient, resolveOgdSocketPath } from './ogd-client'
import {
  OgdAbortedError,
  OgdRequestError,
  OgdTimeoutError,
  OgdUnavailableError,
  OgdVersionError
} from './ogd-connection'
import { startOgdMockServer, type OgdMockServer } from './ogd-mock-server'

const servers: OgdMockServer[] = []
const clients: OgdClient[] = []

async function server(options: Parameters<typeof startOgdMockServer>[0]): Promise<OgdMockServer> {
  const started = await startOgdMockServer(options)
  servers.push(started)
  return started
}

function client(
  socketPath: string,
  extra: Partial<ConstructorParameters<typeof OgdClient>[0]> = {}
) {
  const created = new OgdClient({ socketPath, client: 'orca/test', timeoutMs: 500, ...extra })
  clients.push(created)
  return created
}

afterEach(async () => {
  for (const created of clients.splice(0)) {
    created.close()
  }
  await Promise.all(servers.splice(0).map((started) => started.close()))
})

describe('OgdClient', () => {
  it('handshakes, records features and returns the binary attachment of a reply', async () => {
    const mock = await server({
      features: ['files', 'fuzzy'],
      handle: () => ({ message: { count: 2 }, binary: Buffer.from('a.ts\nb.ts') })
    })
    const ogd = client(mock.socketPath)
    const reply = await ogd.request('files', { root: '/repo' })
    expect(reply.message.count).toBe(2)
    expect(reply.binary?.toString()).toBe('a.ts\nb.ts')
    expect(ogd.hasFeature('fuzzy')).toBe(true)
    expect(mock.requests[0]).toMatchObject({ op: 'files', id: 1, root: '/repo' })
  })

  it('reuses one connection across requests, including a daemon error reply', async () => {
    const mock = await server({
      handle: (request) =>
        request.op === 'search' ? { error: { code: 'not_indexed' } } : { message: {} }
    })
    const ogd = client(mock.socketPath)
    await expect(ogd.request('search', { root: '/repo' })).rejects.toMatchObject({
      name: 'OgdRequestError',
      code: 'not_indexed'
    })
    await ogd.request('status')
    expect(mock.connections).toBe(1)
  })

  it('refuses a daemon that speaks another protocol and backs off before reconnecting', async () => {
    const mock = await server({ proto: 2, handle: () => ({ message: {} }) })
    let now = 1_000
    const ogd = client(mock.socketPath, { now: () => now })
    await expect(ogd.request('status')).rejects.toBeInstanceOf(OgdVersionError)
    await expect(ogd.request('status')).rejects.toBeInstanceOf(OgdUnavailableError)
    expect(mock.connections).toBe(1)
    now += 61_000
    await expect(ogd.request('status')).rejects.toBeInstanceOf(OgdVersionError)
    expect(mock.connections).toBe(2)
  })

  it('reports a missing socket as unavailable and does not retry within the backoff', async () => {
    let now = 0
    const ogd = client(join('/tmp', `ogd-missing-${process.pid}.sock`), { now: () => now })
    await expect(ogd.request('status')).rejects.toBeInstanceOf(OgdUnavailableError)
    now += 1_000
    await expect(ogd.request('status')).rejects.toThrow('backing off')
  })

  it('aborts a pending request, drops its connection and serves the next one on a fresh one', async () => {
    const mock = await server({
      handle: (request) => (request.op === 'fuzzy' ? 'hang' : { message: { ok: true } })
    })
    const ogd = client(mock.socketPath)
    const controller = new AbortController()
    const pending = ogd.request('fuzzy', { query: 'x' }, { signal: controller.signal })
    await new Promise((resolve) => setTimeout(resolve, 20))
    controller.abort()
    await expect(pending).rejects.toBeInstanceOf(OgdAbortedError)
    await ogd.request('status')
    expect(mock.connections).toBe(2)
  })

  it('times out a request the daemon never answers', async () => {
    const mock = await server({ handle: () => 'hang' })
    const ogd = client(mock.socketPath, { timeoutMs: 100 })
    await expect(ogd.request('search')).rejects.toBeInstanceOf(OgdTimeoutError)
  })

  it('fails pending requests when the daemon drops the connection', async () => {
    const mock = await server({ handle: () => 'close' })
    const ogd = client(mock.socketPath)
    const failure = await ogd.request('files').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(OgdUnavailableError)
    expect(failure).not.toBeInstanceOf(OgdRequestError)
  })
})

describe('resolveOgdSocketPath', () => {
  it('prefers POD_SEARCH_SOCKET, then the per-platform default', () => {
    expect(resolveOgdSocketPath({ POD_SEARCH_SOCKET: '/x/ogd.sock' }, 'darwin', '/Users/a')).toBe(
      '/x/ogd.sock'
    )
    expect(resolveOgdSocketPath({}, 'darwin', '/Users/a')).toBe(
      '/Users/a/Library/Caches/pod-search/ogd.sock'
    )
    expect(resolveOgdSocketPath({ XDG_RUNTIME_DIR: '/run/user/1' }, 'linux', '/home/a')).toBe(
      '/run/user/1/pod-search/ogd.sock'
    )
    expect(resolveOgdSocketPath({}, 'linux', '/home/a')).toBeNull()
    expect(resolveOgdSocketPath({}, 'win32', 'C:\\Users\\a')).toBeNull()
  })
})
