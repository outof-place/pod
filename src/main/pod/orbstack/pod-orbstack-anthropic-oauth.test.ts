import { describe, expect, it } from 'vitest'
import {
  createClaudeOAuthSandboxCredentials,
  parseClaudeLogin,
  SandboxCredentialError
} from './pod-orbstack-anthropic-oauth'

// Fake tokens only: no test here ever touches a real keychain item.
const TOKEN = 'fake-oauth-access-token-for-tests'
const REFRESH = 'fake-oauth-refresh-token-for-tests'
const scope = { machine: 'pod-x-sbx' }

function item(accessToken: string, expiresAt?: number): string {
  return JSON.stringify({
    claudeAiOauth: { accessToken, refreshToken: REFRESH, expiresAt, scopes: ['user:inference'] }
  })
}

function harness(initial: string | null, start = 1_000_000) {
  let clock = start
  let value: string | null | Error = initial
  let reads = 0
  const source = createClaudeOAuthSandboxCredentials({
    allowed: () => true,
    now: () => clock,
    target: () => ({ account: 'system', configDir: null }),
    read: async () => {
      reads += 1
      if (value instanceof Error) {
        throw value
      }
      return value
    }
  })
  return {
    source,
    reads: () => reads,
    advance: (ms: number) => (clock += ms),
    set: (next: string | null | Error) => (value = next),
    now: () => clock
  }
}

// Lets a background re-read settle.
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

async function refusal(promise: Promise<unknown>): Promise<SandboxCredentialError> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason
  )
  expect(error).toBeInstanceOf(SandboxCredentialError)
  return error instanceof SandboxCredentialError ? error : new SandboxCredentialError('')
}

describe('sandbox OAuth credential', () => {
  it('keeps only the access token and its expiry from the item', () => {
    const login = parseClaudeLogin(item(TOKEN, 5))
    expect(login).toEqual({ accessToken: TOKEN, expiresAt: 5 })
    expect(JSON.stringify(login)).not.toContain(REFRESH)
    expect(parseClaudeLogin('not json')).toBeNull()
    expect(parseClaudeLogin('{"claudeAiOauth":{}}')).toBeNull()
  })

  it('injects the bearer token and serves it from memory between rechecks', async () => {
    const h = harness(item(TOKEN, 1_000_000 + 3_600_000))
    expect(h.source.mode()).toBe('oauth')
    expect(await h.source.authHeaders(scope)).toEqual({ authorization: `Bearer ${TOKEN}` })
    h.advance(10_000)
    await h.source.authHeaders(scope)
    expect(h.reads()).toBe(1)
  })

  it('re-reads in the background after the recheck interval and picks up a new token', async () => {
    const h = harness(item(TOKEN, 1_000_000 + 3_600_000))
    await h.source.authHeaders(scope)
    h.set(item('fake-oauth-rotated', 1_000_000 + 7_200_000))
    h.advance(31_000)
    // The stale-but-valid token answers at once; the re-read lands for the next request.
    expect(await h.source.authHeaders(scope)).toEqual({ authorization: `Bearer ${TOKEN}` })
    await flush()
    expect(await h.source.authHeaders(scope)).toEqual({
      authorization: 'Bearer fake-oauth-rotated'
    })
    expect(h.reads()).toBe(2)
  })

  it('waits for a fresh read when the token is about to expire, and never refreshes it', async () => {
    const h = harness(item(TOKEN, 1_000_000 + 30_000))
    // Within the expiry margin from the first read: refused with a pane-ready message.
    const expired = await refusal(h.source.authHeaders(scope))
    expect(expired.message).toContain('expired')
    expect(expired.message).toContain('claude')
    // Claude Code on the Mac refreshed the login; the next request reads it.
    h.set(item('fake-oauth-refreshed-on-mac', h.now() + 3_600_000))
    expect(await h.source.authHeaders(scope)).toEqual({
      authorization: 'Bearer fake-oauth-refreshed-on-mac'
    })
  })

  it('says plainly when the Mac has no Claude Code login', async () => {
    const missing = await refusal(harness(null).source.authHeaders(scope))
    expect(missing.message).toContain('No Claude Code login')
    const garbled = await refusal(harness('{"claudeAiOauth":').source.authHeaders(scope))
    expect(garbled.message).toContain('No Claude Code login')
  })

  it('keeps serving a valid token while the keychain is briefly unavailable', async () => {
    const h = harness(item(TOKEN, 1_000_000 + 3_600_000))
    await h.source.authHeaders(scope)
    h.set(new Error('security timed out'))
    h.advance(31_000)
    await h.source.authHeaders(scope)
    await flush()
    expect(await h.source.authHeaders(scope)).toEqual({ authorization: `Bearer ${TOKEN}` })
  })

  it('reads again before the next request once the API refused the token', async () => {
    const h = harness(item(TOKEN, 1_000_000 + 3_600_000))
    await h.source.authHeaders(scope)
    h.set(item('fake-oauth-after-401', 1_000_000 + 3_600_000))
    h.source.rejected(scope)
    expect(await h.source.authHeaders(scope)).toEqual({
      authorization: 'Bearer fake-oauth-after-401'
    })
  })

  it('reads the item once for concurrent first requests', async () => {
    const h = harness(item(TOKEN, 1_000_000 + 3_600_000))
    await Promise.all([1, 2, 3, 4].map(() => h.source.authHeaders(scope)))
    expect(h.reads()).toBe(1)
  })

  it('never puts the token or the refresh token into a refusal', async () => {
    const h = harness(item(TOKEN, 1))
    const error = await refusal(h.source.authHeaders(scope))
    const surface = `${error.message} ${error.stack ?? ''} ${JSON.stringify(error)}`
    expect(surface).not.toContain(TOKEN)
    expect(surface).not.toContain(REFRESH)
  })
})
