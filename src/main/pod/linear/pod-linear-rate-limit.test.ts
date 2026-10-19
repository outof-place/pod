// Fork-only (Pod): the real SDK's errors for Linear's rate-limit answers read as {resetAt}.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LinearAgentAccessError } from '../../linear/issue-context-errors'
import { linearRateLimitFrom, throwIfLinearRateLimited } from './pod-linear-rate-limit'
import {
  guardFetchToLoopback,
  linearMockAuthErrorReply,
  linearMockRateLimitedReply,
  startLinearMockServer,
  type LinearMockReply,
  type LinearMockServer
} from './pod-linear-mock-server.test-support'

const RESET_AT = Date.UTC(2026, 9, 19, 6, 0, 0)
const NOW = Date.UTC(2026, 9, 19, 5, 0, 0)
const saved = {
  apiUrl: process.env.POD_LINEAR_API_URL,
  profile: process.env.ORCA_E2E_USER_DATA_DIR
}

function restoreEnv(
  name: 'POD_LINEAR_API_URL' | 'ORCA_E2E_USER_DATA_DIR',
  value: string | undefined
): void {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}

describe('Linear rate limits from the SDK', () => {
  let server: LinearMockServer | null = null
  let guard: ReturnType<typeof guardFetchToLoopback> | null = null

  beforeEach(() => {
    vi.resetModules()
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    process.env.ORCA_E2E_USER_DATA_DIR = '/private/tmp/pod-linear-rate-limit-profile'
    guard = guardFetchToLoopback()
  })

  afterEach(async () => {
    guard?.restore()
    await server?.close()
    server = null
    restoreEnv('POD_LINEAR_API_URL', saved.apiUrl)
    restoreEnv('ORCA_E2E_USER_DATA_DIR', saved.profile)
    vi.restoreAllMocks()
  })

  async function errorFor(reply: LinearMockReply): Promise<unknown> {
    server = await startLinearMockServer(() => reply)
    process.env.POD_LINEAR_API_URL = server.apiUrl
    const { loadLinearSdk } = await import('../../linear/linear-sdk')
    const client = new (loadLinearSdk().LinearClient)({ apiKey: 'mock-linear-key-1' })
    return client.client.rawRequest('query { viewer { id } }').then(
      () => null,
      (error: unknown) => error
    )
  }

  it('reads the reset from RATELIMITED with its type', async () => {
    const error = await errorFor(linearMockRateLimitedReply(RESET_AT))
    expect(linearRateLimitFrom(error, NOW)).toEqual({ resetAt: RESET_AT })
  })

  it('reads the reset from RATELIMITED with only its code, which the SDK leaves untyped', async () => {
    const typed = linearMockRateLimitedReply(RESET_AT)
    const error = await errorFor({
      ...typed,
      body: { errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATELIMITED' } }] }
    })
    expect(linearRateLimitFrom(error, NOW)).toEqual({ resetAt: RESET_AT })
  })

  it('falls back to Retry-After on a bare 429', async () => {
    const error = await errorFor({ status: 429, headers: { 'Retry-After': '30' }, body: {} })
    expect(linearRateLimitFrom(error, NOW)).toEqual({ resetAt: NOW + 30_000 })
  })

  it('leaves other errors alone', async () => {
    const error = await errorFor(linearMockAuthErrorReply())
    expect(linearRateLimitFrom(error, NOW)).toBeNull()
    expect(() => throwIfLinearRateLimited(error)).not.toThrow()
    expect(guard?.blocked).toEqual([])
  })

  it('throws linear_rate_limited with the reset as data', async () => {
    const error = await errorFor(linearMockRateLimitedReply(RESET_AT))
    let thrown: unknown = null
    try {
      throwIfLinearRateLimited(error)
    } catch (caught) {
      thrown = caught
    }
    expect(thrown).toBeInstanceOf(LinearAgentAccessError)
    expect(thrown).toMatchObject({ code: 'linear_rate_limited', data: { resetAt: RESET_AT } })
  })
})
