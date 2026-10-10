import { describe, expect, it } from 'vitest'
import { readHookRequest } from './pod-orbstack-hook-filter'

const auth = { authorize: (token: string) => token === 'sandbox-token', hookToken: 'server-token' }

function request(lines: string[], body = ''): Buffer {
  return Buffer.from(`${lines.join('\r\n')}\r\n\r\n${body}`, 'latin1')
}

const hookPost = (extra: string[] = [], body = '{"a":1}') =>
  request(
    [
      'POST /hook/claude HTTP/1.1',
      'Host: 127.0.0.1:41234',
      'Content-Type: application/json',
      `Content-Length: ${body.length}`,
      'X-Orca-Agent-Hook-Token: sandbox-token',
      ...extra
    ],
    body
  )

describe('readHookRequest', () => {
  it('forwards one hook post with the server token and Connection: close', () => {
    const verdict = readHookRequest(
      Buffer.concat([hookPost(['Connection: keep-alive']), Buffer.from('GET / HTTP/1.1\r\n\r\n')]),
      auth
    )
    expect(verdict.kind).toBe('forward')
    const text = verdict.kind === 'forward' ? verdict.request.toString('latin1') : ''
    expect(text).toBe(
      [
        'POST /hook/claude HTTP/1.1',
        'Host: 127.0.0.1:41234',
        'Content-Type: application/json',
        'Content-Length: 7',
        'X-Orca-Agent-Hook-Token: server-token',
        'Connection: close',
        '',
        '{"a":1}'
      ].join('\r\n')
    )
  })

  it('waits for the rest of the head or body, asking for 100-continue when the client wants it', () => {
    const full = hookPost(['Expect: 100-continue'])
    expect(readHookRequest(full.subarray(0, 20), auth)).toEqual({
      kind: 'incomplete',
      expectContinue: false
    })
    expect(readHookRequest(full.subarray(0, -3), auth)).toEqual({
      kind: 'incomplete',
      expectContinue: true
    })
    const forwarded = readHookRequest(full, auth)
    expect(forwarded.kind === 'forward' && forwarded.request.toString()).not.toContain('Expect')
  })

  it.each([
    ['another method', request(['GET /hook/claude HTTP/1.1']), 405, 'method'],
    ['another path', request(['POST /hook/codex HTTP/1.1']), 403, 'path'],
    ['a query string', request(['POST /hook/claude?x=1 HTTP/1.1']), 403, 'path'],
    [
      'the server token',
      hookPost().toString().replace('sandbox-token', 'server-token'),
      403,
      'token'
    ],
    ['no token', request(['POST /hook/claude HTTP/1.1', 'Content-Length: 0']), 403, 'token'],
    ['two tokens', hookPost(['X-Orca-Agent-Hook-Token: sandbox-token']), 403, 'token'],
    ['chunked bodies', hookPost(['Transfer-Encoding: chunked']), 411, 'malformed'],
    ['two lengths', hookPost(['Content-Length: 7']), 400, 'malformed'],
    [
      'a malformed line',
      request(['POST /hook/claude HTTP/1.1', 'no colon here']),
      400,
      'malformed'
    ],
    ['garbage', request(['\u0016\u0003\u0001 TLS']), 400, 'malformed'],
    [
      'bodies over 1 MiB',
      request([
        'POST /hook/claude HTTP/1.1',
        'X-Orca-Agent-Hook-Token: sandbox-token',
        'Content-Length: 1048577'
      ]),
      413,
      'size'
    ],
    ['heads over 16 KiB', Buffer.alloc(17 * 1024, 'a'), 431, 'size']
  ])('refuses %s', (_name, bytes, status, reason) => {
    expect(readHookRequest(Buffer.from(bytes), auth)).toMatchObject({
      kind: 'reject',
      status,
      reason
    })
  })

  it('labels a refusal with Pod words only, never the path or method the VM sent', () => {
    const verdict = readHookRequest(request(['PURGE /secret-in-path?key=abc HTTP/1.1']), auth)
    expect(verdict).toMatchObject({ label: { method: 'OTHER', path: '-' } })
  })
})
