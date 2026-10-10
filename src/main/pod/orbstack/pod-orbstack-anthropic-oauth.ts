// Fork-only (Pod): the sandbox route's OAuth credential, the user's choice for VM agents. It reads the
// login a Mac launch would use (Pod's Claude account routing, else the System default) through the
// keychain reader Pod's usage meter already uses, read-only, and keeps only the access token, in
// memory. It never refreshes: Claude Code rotates the refresh token on every refresh, so a refresh
// from Pod would sign the Mac out. Claude Code on the Mac rewrites the item; a later re-read sees it.
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { getClaudeProfileRouter } from '../../claude-accounts/claude-profile-installed-router'
import { readUserClaudeConfigDir } from '../../claude-accounts/claude-profile-paths'
import { readActiveClaudeKeychainCredentialsStrict } from '../../claude-accounts/keychain'
import {
  SandboxCredentialError,
  type SandboxAnthropicCredentials
} from './pod-orbstack-anthropic-route'

const RECHECK_MS = 30_000
const EXPIRY_MARGIN_MS = 60_000

export { SandboxCredentialError }

/** The login a Mac launch would use: the routed account's folder, else the System default. */
export type ClaudeLoginTarget = { account: 'profile' | 'system'; configDir: string | null }

export function resolveMacClaudeLoginTarget(
  deps: { router?: { selectedHome(): string | null } | null; env?: NodeJS.ProcessEnv } = {}
): ClaudeLoginTarget {
  const router = deps.router === undefined ? getClaudeProfileRouter() : deps.router
  let home: string | null
  try {
    home = router?.selectedHome() ?? null
  } catch (error) {
    // A Mac launch refuses a missing account folder too; falling back would run another account.
    throw new SandboxCredentialError(
      error instanceof Error ? error.message : 'The selected Claude account is unavailable.'
    )
  }
  if (home) {
    return { account: 'profile', configDir: home }
  }
  // Claude Code scopes its keychain item by CLAUDE_CONFIG_DIR; the user's own one is their default.
  return { account: 'system', configDir: readUserClaudeConfigDir(deps.env ?? process.env) ?? null }
}

/** That login's own item (keychain, then its .credentials.json), never another login's. */
export async function readClaudeLoginItem(target: ClaudeLoginTarget): Promise<string | null> {
  const fromKeychain = await readActiveClaudeKeychainCredentialsStrict(
    target.configDir ?? undefined
  )
  if (fromKeychain && parseClaudeLogin(fromKeychain)) {
    return fromKeychain
  }
  try {
    return await readFile(
      join(target.configDir ?? join(homedir(), '.claude'), '.credentials.json'),
      'utf8'
    )
  } catch {
    return fromKeychain
  }
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

/**
 * Reads only when a sandbox request asks for a credential: no timer, so with no sandbox using the
 * route there are no `security` spawns at all.
 */
export function createClaudeOAuthSandboxCredentials(
  deps: {
    target?: () => ClaudeLoginTarget
    read?: (target: ClaudeLoginTarget) => Promise<string | null>
    now?: () => number
  } = {}
): Required<Pick<SandboxAnthropicCredentials, 'launched' | 'released' | 'rejected'>> &
  SandboxAnthropicCredentials {
  const targetOf = deps.target ?? (() => resolveMacClaudeLoginTarget())
  const read = deps.read ?? readClaudeLoginItem
  const now = deps.now ?? Date.now
  // Each launched sandbox keeps the login its launch resolved, as a Mac pane keeps the account it
  // was spawned with; a refusal (a routed account whose folder is gone) is kept the same way.
  const pins = new Map<string, ClaudeLoginTarget | SandboxCredentialError>()
  const cached = new Map<string, { login: ClaudeLogin | null; readAt: number }>()
  const reading = new Map<string, Promise<ClaudeLogin | null>>()
  const keyOf = (target: ClaudeLoginTarget) => `${target.account}:${target.configDir ?? ''}`

  const reread = (target: ClaudeLoginTarget, key: string): Promise<ClaudeLogin | null> => {
    const running = reading.get(key)
    if (running) {
      return running
    }
    const done = (async () => {
      let login: ClaudeLogin | null
      try {
        const raw = await read(target)
        login = raw ? parseClaudeLogin(raw) : null
      } catch {
        // Keychain unavailable: keep a still-valid token for this login and retry after the interval.
        login = cached.get(key)?.login ?? null
      }
      cached.set(key, { login, readAt: now() })
      return login
    })().finally(() => reading.delete(key))
    reading.set(key, done)
    return done
  }

  const fresh = (login: ClaudeLogin | null | undefined): login is ClaudeLogin =>
    login != null && (login.expiresAt === null || login.expiresAt - now() > EXPIRY_MARGIN_MS)

  return {
    mode: () => 'oauth',
    launched({ machine }) {
      try {
        pins.set(machine, targetOf())
      } catch (error) {
        pins.set(
          machine,
          error instanceof SandboxCredentialError
            ? error
            : new SandboxCredentialError('The selected Claude account is unavailable.')
        )
      }
    },
    /** The sandbox is gone; with none left, no token stays in memory. */
    released({ machine }) {
      pins.delete(machine)
      if (pins.size === 0) {
        cached.clear()
      }
    },
    async authHeaders({ machine }) {
      const pinned = pins.get(machine)
      if (pinned instanceof SandboxCredentialError) {
        throw pinned
      }
      const target = pinned ?? targetOf()
      const key = keyOf(target)
      const entry = cached.get(key)
      if (entry && fresh(entry.login)) {
        if (now() - entry.readAt >= RECHECK_MS) {
          void reread(target, key)
        }
        return { authorization: `Bearer ${entry.login.accessToken}` }
      }
      const login = await reread(target, key)
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
      cached.clear()
    }
  }
}
