// Fork-only (Pod): what the sandbox relay lets through to the Mac. One Claude hook post per
// connection, with the sandbox's own token swapped for the hook server's; anything else is refused.
import type { PodOrbstackRelayRefusal } from '../../../shared/pod-orbstack-types'

export const SANDBOX_HOOK_PATH = '/hook/claude'
export const SANDBOX_HOOK_TOKEN_HEADER = 'x-orca-agent-hook-token'
const MAX_HEAD_BYTES = 16 * 1024
const MAX_BODY_BYTES = 1024 * 1024
const HEAD_END = Buffer.from('\r\n\r\n')
// Connection-level or proxy headers never reach the hook server; it gets Connection: close instead.
const DROPPED_HEADERS = new Set([
  SANDBOX_HOOK_TOKEN_HEADER,
  'connection',
  'keep-alive',
  'expect',
  'te',
  'trailer',
  'upgrade',
  'proxy-authorization',
  'proxy-connection'
])

/** The request line as the relay log may show it: Pod's own words, never the VM's text. */
export type HookRequestLabel = { method: string; path: string }

export type HookRequestVerdict =
  | { kind: 'incomplete'; expectContinue: boolean }
  | {
      kind: 'reject'
      status: 400 | 403 | 405 | 411 | 413 | 431
      reason: PodOrbstackRelayRefusal
      label: HookRequestLabel
    }
  | { kind: 'forward'; request: Buffer }

const KNOWN_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])

/** A method for the relay log: a standard one as is, anything else as OTHER. */
export function relayLogMethod(method: string | undefined): string {
  return method && KNOWN_METHODS.has(method) ? method : 'OTHER'
}

const UNKNOWN: HookRequestLabel = { method: '-', path: '-' }

const REASONS: Record<number, string> = {
  400: 'Bad Request',
  403: 'Forbidden',
  405: 'Method Not Allowed',
  411: 'Length Required',
  413: 'Content Too Large',
  431: 'Request Header Fields Too Large'
}

export function hookRejection(status: number): Buffer {
  return Buffer.from(
    `HTTP/1.1 ${status} ${REASONS[status] ?? 'Error'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
  )
}

export const HOOK_CONTINUE = Buffer.from('HTTP/1.1 100 Continue\r\n\r\n')

/**
 * Reads the bytes a sandbox sent so far. `authorize` checks the sandbox's token; `hookToken` is the
 * hook server's, which only the Mac side knows.
 */
export function readHookRequest(
  buffered: Buffer,
  auth: { authorize: (token: string) => boolean; hookToken: string }
): HookRequestVerdict {
  const headEnd = buffered.indexOf(HEAD_END)
  if (headEnd === -1) {
    return buffered.length > MAX_HEAD_BYTES
      ? { kind: 'reject', status: 431, reason: 'size', label: UNKNOWN }
      : { kind: 'incomplete', expectContinue: false }
  }
  if (headEnd > MAX_HEAD_BYTES) {
    return { kind: 'reject', status: 431, reason: 'size', label: UNKNOWN }
  }
  const [requestLine = '', ...lines] = buffered
    .subarray(0, headEnd)
    .toString('latin1')
    .split('\r\n')
  const request = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(requestLine)
  if (!request) {
    return { kind: 'reject', status: 400, reason: 'malformed', label: UNKNOWN }
  }
  const label: HookRequestLabel = {
    method: relayLogMethod(request[1]),
    path: request[2] === SANDBOX_HOOK_PATH ? SANDBOX_HOOK_PATH : '-'
  }
  if (request[1] !== 'POST') {
    return { kind: 'reject', status: 405, reason: 'method', label }
  }
  if (request[2] !== SANDBOX_HOOK_PATH) {
    return { kind: 'reject', status: 403, reason: 'path', label }
  }
  const kept: string[] = []
  const seen = new Map<string, string[]>()
  for (const line of lines) {
    const colon = line.indexOf(':')
    if (colon <= 0 || /[\0\r\n]/.test(line)) {
      return { kind: 'reject', status: 400, reason: 'malformed', label }
    }
    const name = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    seen.set(name, [...(seen.get(name) ?? []), value])
    if (!DROPPED_HEADERS.has(name) && !name.startsWith('proxy-')) {
      kept.push(line)
    }
  }
  if (seen.has('transfer-encoding')) {
    return { kind: 'reject', status: 411, reason: 'malformed', label }
  }
  const tokens = seen.get(SANDBOX_HOOK_TOKEN_HEADER) ?? []
  if (tokens.length !== 1 || !auth.authorize(tokens[0] ?? '')) {
    return { kind: 'reject', status: 403, reason: 'token', label }
  }
  const lengths = seen.get('content-length') ?? ['0']
  if (lengths.length !== 1 || !/^\d{1,8}$/.test(lengths[0] ?? '')) {
    return { kind: 'reject', status: 400, reason: 'malformed', label }
  }
  const length = Number(lengths[0])
  if (length > MAX_BODY_BYTES) {
    return { kind: 'reject', status: 413, reason: 'size', label }
  }
  const bodyStart = headEnd + HEAD_END.length
  if (buffered.length - bodyStart < length) {
    const expect = seen.get('expect') ?? []
    return { kind: 'incomplete', expectContinue: expect.includes('100-continue') }
  }
  const head = [
    `POST ${SANDBOX_HOOK_PATH} HTTP/1.1`,
    ...kept,
    `X-Orca-Agent-Hook-Token: ${auth.hookToken}`,
    'Connection: close',
    '',
    ''
  ].join('\r\n')
  // Bytes past the body (a pipelined second request) are dropped: one post per connection.
  return {
    kind: 'forward',
    request: Buffer.concat([
      Buffer.from(head, 'latin1'),
      buffered.subarray(bodyStart, bodyStart + length)
    ])
  }
}
