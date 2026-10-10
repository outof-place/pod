// Fork-only (Pod): the sandbox route's OAuth credential, the user's choice for VM agents. It reads the
// Mac's active Claude Code login (the keychain item Pod's usage meter already reads), read-only, and
// keeps only the access token, in memory. It never refreshes: Claude Code on the Mac owns the login
// and rewrites the item when it refreshes, which the next re-read picks up.
import { z } from 'zod'
import { readActiveClaudeKeychainCredentialsStrict } from '../../claude-accounts/keychain'
import type { SandboxAnthropicCredentials } from './pod-orbstack-anthropic-route'

const RECHECK_MS = 30_000
const EXPIRY_MARGIN_MS = 60_000

/** A refusal whose message is safe to show the sandbox: it never carries the token. */
export class SandboxCredentialError extends Error {
  override name = 'SandboxCredentialError'
}

type ClaudeLogin = { accessToken: string; expiresAt: number | null }

const credentialsSchema = z.object({
  claudeAiOauth: z.object({
    accessToken: z.string().min(1),
    expiresAt: z.number().optional()
  })
})

/** Only the access token and its expiry leave the raw item; the refresh token is never kept. */
export function parseClaudeLogin(raw: string): ClaudeLogin | null {
  try {
    const parsed = credentialsSchema.safeParse(JSON.parse(raw))
    return parsed.success
      ? {
          accessToken: parsed.data.claudeAiOauth.accessToken,
          expiresAt: parsed.data.claudeAiOauth.expiresAt ?? null
        }
      : null
  } catch {
    return null
  }
}

export function createClaudeOAuthSandboxCredentials(
  deps: {
    /** The raw keychain item; the default reads the active login's "Claude Code-credentials". */
    read?: () => Promise<string | null>
    now?: () => number
  } = {}
): SandboxAnthropicCredentials & { rejected(): void } {
  const read = deps.read ?? (() => readActiveClaudeKeychainCredentialsStrict())
  const now = deps.now ?? Date.now
  let cached: { login: ClaudeLogin | null; readAt: number } | null = null
  let reading: Promise<void> | null = null

  const reread = (): Promise<void> => {
    reading ??= (async () => {
      try {
        const raw = await read()
        cached = { login: raw ? parseClaudeLogin(raw) : null, readAt: now() }
      } catch {
        // Keychain unavailable: keep a still-valid token, and try again after the recheck interval.
        cached = { login: cached?.login ?? null, readAt: now() }
      } finally {
        reading = null
      }
    })()
    return reading
  }

  const fresh = (login: ClaudeLogin | null | undefined): login is ClaudeLogin =>
    login != null && (login.expiresAt === null || login.expiresAt - now() > EXPIRY_MARGIN_MS)

  return {
    mode: () => 'oauth',
    async authHeaders() {
      if (cached && fresh(cached.login)) {
        if (now() - cached.readAt >= RECHECK_MS) {
          void reread()
        }
        return { authorization: `Bearer ${cached.login.accessToken}` }
      }
      await reread()
      const login = cached?.login
      if (fresh(login)) {
        return { authorization: `Bearer ${login.accessToken}` }
      }
      throw new SandboxCredentialError(
        login
          ? 'The Claude Code login on this Mac has expired. Run `claude` on the Mac to refresh it, then retry.'
          : 'No Claude Code login found on this Mac. Run `claude` on the Mac and sign in, then retry.'
      )
    },
    /** The API refused the token (401): the next request waits for a fresh read of the item. */
    rejected() {
      cached = null
    }
  }
}
