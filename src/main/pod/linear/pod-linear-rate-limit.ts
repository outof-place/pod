// Fork-only (Pod): Linear's rate limit as a typed linear_rate_limited {resetAt}, read from the
// response. Linear answers an exhausted limit with HTTP 400 and RATELIMITED (or a 429); the SDK maps
// that to RatelimitedLinearError, with the X-RateLimit-*-Reset headers parsed when its type is set.
import { linearError } from '../../linear/issue-context-errors'

export type LinearRateLimit = {
  /** When the exhausted window resets, in epoch milliseconds; null when Linear didn't say. */
  resetAt: number | null
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === 'string' ? Number(value) : value
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null
}

function header(error: unknown, name: string): unknown {
  const headers = field(field(field(error, 'raw'), 'response'), 'headers')
  const get = field(headers, 'get')
  return typeof get === 'function' ? Reflect.apply(get, headers, [name]) : undefined
}

function hasRateLimitedCode(error: unknown): boolean {
  const errors = field(field(field(error, 'raw'), 'response'), 'errors')
  return (
    Array.isArray(errors) &&
    errors.some((entry) => field(field(entry, 'extensions'), 'code') === 'RATELIMITED')
  )
}

/** The rate limit an SDK error reports, or null when the error is something else. */
export function linearRateLimitFrom(
  error: unknown,
  now: number = Date.now()
): LinearRateLimit | null {
  const limited =
    field(error, 'type') === 'Ratelimited' ||
    field(error, 'status') === 429 ||
    hasRateLimitedCode(error)
  if (!limited) {
    return null
  }
  // The later reset wins: requests and complexity are separate windows, and both must reopen.
  const resets = [
    finiteNumber(field(error, 'requestsResetAt') ?? header(error, 'x-ratelimit-requests-reset')),
    finiteNumber(field(error, 'complexityResetAt') ?? header(error, 'x-ratelimit-complexity-reset'))
  ].filter((value): value is number => value !== null)
  if (resets.length > 0) {
    return { resetAt: Math.max(...resets) }
  }
  const retryAfterSeconds = finiteNumber(field(error, 'retryAfter') ?? header(error, 'retry-after'))
  return { resetAt: retryAfterSeconds === null ? null : now + retryAfterSeconds * 1000 }
}

/** Throws linear_rate_limited {resetAt} for a rate-limit error; returns for anything else. */
export function throwIfLinearRateLimited(error: unknown): void {
  const limit = linearRateLimitFrom(error)
  if (!limit) {
    return
  }
  const until = limit.resetAt === null ? '' : ` until ${new Date(limit.resetAt).toISOString()}`
  throw linearError('linear_rate_limited', `Linear's rate limit is reached${until}.`, limit)
}
