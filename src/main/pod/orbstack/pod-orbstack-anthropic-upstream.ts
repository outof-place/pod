// Fork-only (Pod): the sandbox route's upstream leg. One HTTP/2 session to api.anthropic.com per
// Pod process, shared by every sandbox; no listener and no credentials of its own: the route hands
// it requests with the VM's auth already replaced.
import {
  connect,
  constants as h2,
  type ClientHttp2Session,
  type ClientHttp2Stream,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders
} from 'node:http2'
import { pipeline, type Readable } from 'node:stream'
import { createGzip } from 'node:zlib'
import { ANTHROPIC_API_HOST } from './pod-orbstack-sandbox-ca'

export type AnthropicUpstreamTarget = { host: string; port: number; ca?: string }

export type AnthropicUpstreamRequest = {
  method: string
  /** Allowlisted and plain, query included. */
  path: string
  headers: Record<string, string | string[]>
  body: Readable
  signal: AbortSignal
}

export type AnthropicUpstreamResponse = {
  status: number
  /** Raw name/value pairs, as `writeHead` takes them. */
  headers: string[]
  body: Readable
}

const CONNECT_TIMEOUT_MS = 10_000
// Why: a NAT or load balancer can drop a long-idle connection silently; start fresh instead.
const IDLE_CLOSE_MS = 60_000
// Why: only the Messages API is known to take gzip bodies (Claude Code gzips them itself first-party).
const GZIP_PATH = /^\/v1\/messages(\/count_tokens)?(\?|$)/
const GZIP_MIN_BYTES = 1024

// HTTP/2 forbids connection-specific headers; :authority replaces host.
const CONNECTION_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'te',
  'host',
  'http2-settings'
])

function requestHeaders(request: AnthropicUpstreamRequest, gzip: boolean): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {
    [h2.HTTP2_HEADER_METHOD]: request.method,
    [h2.HTTP2_HEADER_PATH]: request.path,
    [h2.HTTP2_HEADER_AUTHORITY]: ANTHROPIC_API_HOST
  }
  for (const [rawName, value] of Object.entries(request.headers)) {
    const name = rawName.toLowerCase()
    if (!CONNECTION_HEADERS.has(name) && !name.startsWith(':')) {
      headers[name] = value
    }
  }
  if (gzip) {
    headers['content-encoding'] = 'gzip'
    delete headers['content-length']
  }
  return headers
}

function rawResponseHeaders(headers: IncomingHttpHeaders): string[] {
  const pairs: string[] = []
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || name.startsWith(':') || CONNECTION_HEADERS.has(name)) {
      continue
    }
    for (const item of Array.isArray(value) ? value : [value]) {
      pairs.push(name, String(item))
    }
  }
  return pairs
}

function shouldGzip(request: AnthropicUpstreamRequest): boolean {
  if (request.method !== 'POST' || !GZIP_PATH.test(request.path)) {
    return false
  }
  const header = (name: string): string | undefined => {
    const value = request.headers[name] ?? request.headers[name.toLowerCase()]
    return Array.isArray(value) ? value[0] : value
  }
  if (header('content-encoding') !== undefined) {
    return false
  }
  const length = Number(header('content-length'))
  return !Number.isFinite(length) || length >= GZIP_MIN_BYTES
}

export function createAnthropicUpstream(
  options: {
    target?: AnthropicUpstreamTarget
    /** Method, path and error text only; never headers or bodies. */
    log?: (message: string) => void
  } = {}
) {
  const target = options.target ?? { host: ANTHROPIC_API_HOST, port: 443 }
  const log = options.log ?? (() => {})
  let session: ClientHttp2Session | null = null
  const active = new WeakMap<ClientHttp2Session, number>()

  const open = (): ClientHttp2Session => {
    if (session && !session.closed && !session.destroyed) {
      return session
    }
    const next = connect(`https://${target.host}:${target.port}`, {
      servername: ANTHROPIC_API_HOST,
      ...(target.ca ? { ca: target.ca } : {})
    })
    const forget = (): void => {
      if (session === next) {
        session = null
      }
    }
    const connectTimer = setTimeout(
      () => next.destroy(new Error('connect timed out')),
      CONNECT_TIMEOUT_MS
    )
    next.once('connect', () => {
      clearTimeout(connectTimer)
      if (next.alpnProtocol !== 'h2') {
        next.destroy(new Error(`upstream negotiated ${String(next.alpnProtocol)}, not h2`))
      }
    })
    next.on('error', (error) => log(`upstream session error: ${error.message}`))
    next.on('goaway', forget)
    next.on('close', () => {
      clearTimeout(connectTimer)
      forget()
    })
    // Graceful: streams still open finish; the next request opens a new session.
    next.setTimeout(IDLE_CLOSE_MS, () => {
      forget()
      next.close()
    })
    // Why: an idle session must not keep Pod (or a test run) alive.
    next.unref()
    session = next
    return next
  }

  function request(args: AnthropicUpstreamRequest): Promise<AnthropicUpstreamResponse> {
    return new Promise((resolve, reject) => {
      if (args.signal.aborted) {
        args.body.resume()
        reject(new Error('aborted'))
        return
      }
      const gzip = shouldGzip(args)
      let owner: ClientHttp2Session
      let stream: ClientHttp2Stream
      try {
        owner = open()
        stream = owner.request(requestHeaders(args, gzip))
      } catch (error) {
        // Why: Node's invalid-header errors quote the value, and that value can be the credential.
        const code = error instanceof Error && 'code' in error ? String(error.code) : 'unknown'
        args.body.resume()
        reject(new Error(`upstream refused the request headers (${code})`))
        return
      }
      const cancel = (): void => {
        if (!stream.closed) {
          stream.close(h2.NGHTTP2_CANCEL)
        }
      }
      args.signal.addEventListener('abort', cancel, { once: true })
      // Why: an idle session is unref'd, but an exchange in flight must keep the process alive.
      active.set(owner, (active.get(owner) ?? 0) + 1)
      owner.ref()
      stream.once('close', () => {
        args.signal.removeEventListener('abort', cancel)
        const left = (active.get(owner) ?? 1) - 1
        active.set(owner, left)
        if (left === 0) {
          owner.unref()
        }
      })

      let responded = false
      stream.once('response', (headers) => {
        responded = true
        resolve({
          status: Number(headers[h2.HTTP2_HEADER_STATUS] ?? 502),
          headers: rawResponseHeaders(headers),
          body: stream
        })
      })
      // Why `on`: an error after the response reaches the body's consumer; a second one must not crash.
      stream.on('error', (error) => {
        log(`upstream ${args.method} ${args.path.split('?')[0]} failed: ${error.message}`)
        if (!responded) {
          reject(error)
        }
      })
      // A cancelled or refused stream closes without an error event.
      stream.once('close', () => {
        if (!responded) {
          reject(new Error(`upstream stream closed before a response (code ${stream.rstCode})`))
        }
      })
      // Why pipeline: a body error or a stalled upstream window backpressures and cancels cleanly.
      const done = (error: Error | null): void => {
        if (error && !stream.closed) {
          cancel()
        }
      }
      if (gzip) {
        pipeline(args.body, createGzip(), stream, done)
      } else {
        pipeline(args.body, stream, done)
      }
    })
  }

  return {
    request,
    close(): void {
      session?.close()
      session = null
    }
  }
}

export type AnthropicUpstreamClient = ReturnType<typeof createAnthropicUpstream>
