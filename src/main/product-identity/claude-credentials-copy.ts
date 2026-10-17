import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Read and add only: this code never deletes a Keychain item, the legacy app's least of all. */
export type ClaudeCredentialsKeychainPort = {
  hasItem(service: string, account: string): boolean
  readSecret(service: string, account: string): string | null
  writeSecret(service: string, account: string, secret: string, trustedAppPath: string | null): void
}

/** One managed Claude profile: where Claude filed its sign-in for the legacy and product copy. */
export type ClaudeProfileCredentials = {
  id: string
  /** Every service name Claude may have hashed the legacy profile's folder into. */
  legacyServices: string[]
  productService: string
}

export type ClaudeCredentialsCopyResult =
  | { status: 'copied'; copied: string[]; denied: string[] }
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
 * under the product's userData finds nothing. This copies each sign-in to the product folder's
 * item and leaves the legacy item in place. Only while the legacy app is not running, so the copy
 * holds its newest token. A denied read copies nothing; that profile signs in again.
 */
export function copyClaudeProfileCredentials(options: {
  profiles: readonly ClaudeProfileCredentials[]
  keychainAccount: string
  trustedAppPath: string | null
  legacyAppPid: number | null
  keychain: ClaudeCredentialsKeychainPort
}): ClaudeCredentialsCopyResult {
  const { keychain, keychainAccount: account } = options
  const pending = options.profiles
    .map((profile) => ({
      profile,
      found: profile.legacyServices.find((service) => keychain.hasItem(service, account))
    }))
    .filter(
      ({ profile, found }) =>
        found !== undefined && !keychain.hasItem(profile.productService, account)
    )
  if (pending.length === 0) {
    return { status: 'not-needed', reason: 'no-legacy-sign-ins' }
  }
  if (options.legacyAppPid !== null) {
    return { status: 'deferred', reason: 'legacy-app-running', pid: options.legacyAppPid }
  }
  const copied: string[] = []
  const denied: string[] = []
  for (const { profile, found } of pending) {
    const secret = found === undefined ? null : keychain.readSecret(found, account)
    if (secret === null) {
      denied.push(profile.id)
      continue
    }
    keychain.writeSecret(profile.productService, account, secret, options.trustedAppPath)
    copied.push(profile.id)
  }
  return { status: 'copied', copied, denied }
}
