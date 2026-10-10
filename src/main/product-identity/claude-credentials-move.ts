import { readdirSync } from 'node:fs'
import { join } from 'node:path'

export type ClaudeCredentialsKeychainPort = {
  hasItem(service: string, account: string): boolean
  readSecret(service: string, account: string): string | null
  writeSecret(service: string, account: string, secret: string, trustedAppPath: string | null): void
  deleteItem(service: string, account: string): boolean
}

/** One managed Claude profile: where Claude filed its sign-in for the legacy and product copy. */
export type ClaudeProfileCredentials = {
  id: string
  /** Every service name Claude may have hashed the legacy profile's folder into. */
  legacyServices: string[]
  productService: string
}

export type ClaudeCredentialsMoveResult =
  | { status: 'moved'; moved: string[]; denied: string[]; legacyKept: string[] }
  | { status: 'not-needed'; reason: 'no-legacy-sign-ins' }
  | { status: 'deferred'; reason: 'legacy-app-running'; pid: number }

const PROFILE_ID = /^[a-zA-Z0-9_-]+$/

/** Managed Claude profiles are folders named by account id under `<userData>/claude-profiles`. */
export function listClaudeProfileIds(userData: string): string[] {
  try {
    return readdirSync(join(userData, 'claude-profiles'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && PROFILE_ID.test(entry.name))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * Claude names a profile's Keychain item after the profile folder's path, so an imported copy
 * under the product's userData finds nothing. This moves each sign-in to the product folder's
 * item. Only while the legacy app is not running: it refreshes these tokens, and a copy it
 * rotates later leaves the product with a dead refresh token. A denied read keeps the legacy
 * item; that profile signs in again.
 */
export function moveClaudeProfileCredentials(options: {
  profiles: readonly ClaudeProfileCredentials[]
  keychainAccount: string
  trustedAppPath: string | null
  legacyAppPid: number | null
  keychain: ClaudeCredentialsKeychainPort
}): ClaudeCredentialsMoveResult {
  const { keychain, keychainAccount: account } = options
  const pending = options.profiles
    .map((profile) => ({
      profile,
      found: profile.legacyServices.filter((service) => keychain.hasItem(service, account))
    }))
    .filter(
      ({ profile, found }) => found.length > 0 && !keychain.hasItem(profile.productService, account)
    )
  if (pending.length === 0) {
    return { status: 'not-needed', reason: 'no-legacy-sign-ins' }
  }
  if (options.legacyAppPid !== null) {
    return { status: 'deferred', reason: 'legacy-app-running', pid: options.legacyAppPid }
  }
  const moved: string[] = []
  const denied: string[] = []
  const legacyKept: string[] = []
  for (const { profile, found } of pending) {
    const secret = keychain.readSecret(found[0], account)
    if (secret === null) {
      denied.push(profile.id)
      continue
    }
    keychain.writeSecret(profile.productService, account, secret, options.trustedAppPath)
    moved.push(profile.id)
    // Why keep going on a failed delete: the product item is in place; a stale legacy copy only
    // matters to the legacy app, which refreshes its own token when it next runs.
    if (!found.every((service) => keychain.deleteItem(service, account))) {
      legacyKept.push(profile.id)
    }
  }
  return { status: 'moved', moved, denied, legacyKept }
}
