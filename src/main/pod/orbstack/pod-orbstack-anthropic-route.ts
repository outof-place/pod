// Fork-only (Pod): the sandbox relay's `anthropic-api` route. The VM pins api.anthropic.com to its
// own 127.0.0.1:443; the relay hands those bytes here, where TLS ends under the sandbox's CA and
// each allowed request goes on to the real api.anthropic.com with Pod's credential in place of the VM's.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Agent, request as httpsRequest } from 'node:https'
import type { Duplex } from 'node:stream'
import { createSecureContext, TLSSocket } from 'node:tls'
import { OPEN_PRIVACY, type SandboxPrivacy } from './pod-orbstack-privacy-env'
import { ANTHROPIC_API_HOST, type SandboxCa } from './pod-orbstack-sandbox-ca'

/** Where the credential comes from. Pod ships the stub; the user picks the real source. */
export type SandboxAnthropicCredentials = {
  /** 'off' keeps the route closed and the VM unpinned. */
  mode(): 'off' | 'api-key' | 'oauth'
  /** Auth headers for one upstream request, e.g. `x-api-key`; null refuses the request. */
  authHeaders(scope: { machine: string }): Promise<Record<string, string> | null>
}

export const STUB_SANDBOX_ANTHROPIC_CREDENTIALS: SandboxAnthropicCredentials = {
  mode: () => 'off',
  authHeaders: async () => null
}

let credentials: SandboxAnthropicCredentials = STUB_SANDBOX_ANTHROPIC_CREDENTIALS

/** The plug for a real credential source (API key or OAuth); null restores the stub. */
export function setPodSandboxAnthropicCredentials(
  source: SandboxAnthropicCredentials | null
): void {
  credentials = source ?? STUB_SANDBOX_ANTHROPIC_CREDENTIALS
}

export function getPodSandboxAnthropicCredentials(): SandboxAnthropicCredentials {
  return credentials
}

/** The real API by default; E2E runs point it at a stub with its own CA. */
export type AnthropicUpstream = { host: string; port: number; ca?: string }
export const ANTHROPIC_UPSTREAM: AnthropicUpstream = { host: ANTHROPIC_API_HOST, port: 443 }

// What Claude Code calls on api.anthropic.com with an API key, observed from 2.1.287 against a stub;
// forwarding all of it keeps the VM's Claude Code behaving as on the Mac. Everything else (the
// admin API, files, OAuth endpoints) is refused here.
// `off` names the Mac privacy switch that closes an entry for the sandbox too.
const ALLOWED: readonly {
  method: string
  path: RegExp
  auth: boolean
  off?: keyof Pick<SandboxPrivacy, 'telemetryOff' | 'featureFlagsOff'>
}[] = [
  { method: 'POST', path: /^\/v1\/messages(\?.*)?$/, auth: true },
  { method: 'POST', path: /^\/v1\/messages\/count_tokens(\?.*)?$/, auth: true },
  { method: 'GET', path: /^\/v1\/models(\/[\w.-]+)?(\?.*)?$/, auth: true },
  // Server-managed settings, policy limits, feature flags, bootstrap config, telemetry.
  { method: 'GET', path: /^\/api\/claude_code\/[\w/.-]+(\?.*)?$/, auth: true },
  { method: 'GET', path: /^\/api\/claude_code_penguin_mode(\?.*)?$/, auth: true },
  { method: 'GET', path: /^\/api\/claude_cli\/bootstrap(\?.*)?$/, auth: true },
  { method: 'POST', path: /^\/api\/eval\/[\w-]+(\?.*)?$/, auth: true, off: 'featureFlagsOff' },
  {
    method: 'POST',
    path: /^\/api\/event_logging\/v2\/batch(\?.*)?$/,
    auth: true,
    off: 'telemetryOff'
  },
  { method: 'GET', path: /^\/mcp-registry\/v0\/servers(\?.*)?$/, auth: false },
  // Unauthenticated connection warm-up.
  { method: 'GET', path: /^\/api\/hello$/, auth: false },
  { method: 'HEAD', path: /^\/api\/hello$/, auth: false }
]

/** No dot segments, empty segments or escapes, so the API cannot resolve a path past the rules. */
function isPlainPath(path: string): boolean {
  const [pathname = ''] = path.split('?')
  return (
    /^(\/[\w.-]+)+\/?$/.test(pathname) &&
    pathname.split('/').every((segment) => segment !== '.' && segment !== '..')
  )
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host'
])
// Whatever auth the VM sends is dropped; only the credential source's headers go upstream.
const VM_AUTH = new Set(['authorization', 'x-api-key', 'cookie'])

function forwardableRequestHeaders(raw: string[]): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {}
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const key = (raw[i] ?? '').toLowerCase()
    if (HOP_BY_HOP.has(key) || VM_AUTH.has(key) || key.startsWith('proxy-')) {
      continue
    }
    const value = raw[i + 1] ?? ''
    const existing = headers[key]
    headers[key] = existing === undefined ? value : [existing, value].flat()
  }
  return headers
}

function forwardableResponseHeaders(raw: string[]): string[] {
  const kept: string[] = []
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const key = (raw[i] ?? '').toLowerCase()
    if (!HOP_BY_HOP.has(key) && !key.startsWith('proxy-')) {
      kept.push(raw[i] ?? '', raw[i + 1] ?? '')
    }
  }
  return kept
}

function apiError(res: ServerResponse, status: number, type: string, message: string): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(status, { 'content-type': 'application/json', connection: 'close' })
  res.end(JSON.stringify({ type: 'error', error: { type, message } }))
}

export function createAnthropicRoute(args: {
  machine: string
  ca: SandboxCa
  credentials?: () => SandboxAnthropicCredentials
  upstream?: AnthropicUpstream
  /** The Mac's privacy switches, read per request; they close telemetry and flag fetches. */
  privacy?: () => SandboxPrivacy
  log?: (message: string) => void
}) {
  const upstream = args.upstream ?? ANTHROPIC_UPSTREAM
  const source = args.credentials ?? getPodSandboxAnthropicCredentials
  const agent = new Agent({ keepAlive: true, maxSockets: 16 })
  const secureContext = createSecureContext({ key: args.ca.leafKeyPem, cert: args.ca.leafCertPem })

  const proxy = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = req.url ?? '/'
    const privacy = (args.privacy ?? (() => OPEN_PRIVACY))()
    const rule = isPlainPath(path)
      ? ALLOWED.find(
          (entry) =>
            entry.method === req.method &&
            entry.path.test(path) &&
            !(entry.off && privacy[entry.off])
        )
      : undefined
    if (!rule) {
      args.log?.(`refused ${req.method} ${path.split('?')[0]}`)
      req.resume()
      apiError(res, 403, 'permission_error', 'Pod does not forward this request from a sandbox.')
      return
    }
    const auth = rule.auth ? await source().authHeaders({ machine: args.machine }) : {}
    if (!auth) {
      req.resume()
      apiError(res, 401, 'authentication_error', 'Pod has no credential for this sandbox.')
      return
    }
    const upstreamRequest = httpsRequest(
      {
        host: upstream.host,
        port: upstream.port,
        servername: ANTHROPIC_API_HOST,
        ...(upstream.ca ? { ca: upstream.ca } : {}),
        method: req.method,
        path,
        agent,
        headers: { ...forwardableRequestHeaders(req.rawHeaders), ...auth, host: ANTHROPIC_API_HOST }
      },
      (reply) => {
        res.writeHead(reply.statusCode ?? 502, forwardableResponseHeaders(reply.rawHeaders))
        reply.pipe(res)
      }
    )
    upstreamRequest.on('error', (error) => {
      args.log?.(`upstream ${req.method} ${path.split('?')[0]} failed: ${error.message}`)
      apiError(res, 502, 'api_error', 'Pod could not reach api.anthropic.com.')
    })
    res.on('close', () => {
      if (!res.writableFinished) {
        upstreamRequest.destroy()
      }
    })
    req.pipe(upstreamRequest)
  }

  const server = createServer((req, res) => {
    void proxy(req, res)
  })

  return {
    caCertPem: args.ca.caCertPem,
    /** Takes one VM connection to 127.0.0.1:443 and serves it as api.anthropic.com. */
    attach(stream: Duplex): void {
      const tls = new TLSSocket(stream, {
        isServer: true,
        secureContext,
        ALPNProtocols: ['http/1.1'],
        SNICallback: (servername, callback) =>
          servername === ANTHROPIC_API_HOST
            ? callback(null, secureContext)
            : callback(new Error(`refused SNI ${servername}`))
      })
      tls.on('error', () => tls.destroy())
      tls.on('secure', () => {
        // A client that sent no SNI never reached the callback above.
        if (tls.servername !== ANTHROPIC_API_HOST) {
          tls.destroy()
        }
      })
      server.emit('connection', tls)
    },
    close(): void {
      server.close()
      agent.destroy()
    }
  }
}

export type AnthropicRoute = ReturnType<typeof createAnthropicRoute>
