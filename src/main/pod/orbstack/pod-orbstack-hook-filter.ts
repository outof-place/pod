// Fork-only (Pod): what the sandbox relay lets through to the Mac. One Claude hook post per
// connection, with the sandbox's own token swapped for the hook server's; anything else is refused.

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

export type HookRequestVerdict =
  | { kind: 'incomplete'; expectContinue: boolean }
  | { kind: 'reject'; status: 400 | 403 | 405 | 411 | 413 | 431 }
  | { kind: 'forward'; request: Buffer }

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
      ? { kind: 'reject', status: 431 }
      : { kind: 'incomplete', expectContinue: false }
  }
  if (headEnd > MAX_HEAD_BYTES) {
    return { kind: 'reject', status: 431 }
  }
  const [requestLine = '', ...lines] = buffered
    .subarray(0, headEnd)
    .toString('latin1')
    .split('\r\n')
  const request = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(requestLine)
  if (!request) {
    return { kind: 'reject', status: 400 }
  }
  if (request[1] !== 'POST') {
    return { kind: 'reject', status: 405 }
  }
  if (request[2] !== SANDBOX_HOOK_PATH) {
    return { kind: 'reject', status: 403 }
  }
  const kept: string[] = []
  const seen = new Map<string, string[]>()
  for (const line of lines) {
    const colon = line.indexOf(':')
    if (colon <= 0 || /[\0\r\n]/.test(line)) {
      return { kind: 'reject', status: 400 }
    }
    const name = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    seen.set(name, [...(seen.get(name) ?? []), value])
    if (!DROPPED_HEADERS.has(name) && !name.startsWith('proxy-')) {
      kept.push(line)
    }
  }
  if (seen.has('transfer-encoding')) {
    return { kind: 'reject', status: 411 }
  }
  const tokens = seen.get(SANDBOX_HOOK_TOKEN_HEADER) ?? []
  if (tokens.length !== 1 || !auth.authorize(tokens[0] ?? '')) {
    return { kind: 'reject', status: 403 }
  }
  const lengths = seen.get('content-length') ?? ['0']
  if (lengths.length !== 1 || !/^\d{1,8}$/.test(lengths[0] ?? '')) {
    return { kind: 'reject', status: 400 }
  }
  const length = Number(lengths[0])
  if (length > MAX_BODY_BYTES) {
    return { kind: 'reject', status: 413 }
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
