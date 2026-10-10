import { runProcessSync } from '@orca/process-host'
import type { SafeStorageKeychainPort } from './legacy-profile-migration'

const SECURITY = '/usr/bin/security'
// Reading another app's item shows a macOS consent prompt; give the user time to answer it.
const CONSENT_TIMEOUT_MS = 5 * 60_000
const COMMAND_TIMEOUT_MS = 10_000
const QUOTE_UNSAFE = /[\r\n"\\]/

function assertQuotable(values: readonly string[]): void {
  if (values.some((value) => QUOTE_UNSAFE.test(value))) {
    throw new Error('keychain item names must not contain quotes, backslashes or newlines')
  }
}

/** `security` CLI access to the login keychain, or to `keychainPath` (tests use a scratch keychain). */
export function createMacSafeStorageKeychain(keychainPath?: string): SafeStorageKeychainPort {
  const keychainArgs = keychainPath ? [keychainPath] : []
  const hasItem = (service: string, account: string): boolean => {
    // Without -w this reads attributes only, which never prompts.
    const result = runProcessSync({
      program: SECURITY,
      args: ['find-generic-password', '-s', service, '-a', account, ...keychainArgs],
      timeoutMs: COMMAND_TIMEOUT_MS
    })
    return result.code === 0
  }
  return {
    hasItem,
    readSecret(service, account) {
      const result = runProcessSync({
        program: SECURITY,
        args: ['find-generic-password', '-s', service, '-a', account, '-w', ...keychainArgs],
        timeoutMs: CONSENT_TIMEOUT_MS
      })
      return result.code === 0 && !result.timedOut ? result.stdout.trim() : null
    },
    writeSecret(service, account, secret, trustedAppPath) {
      assertQuotable([service, account, secret, trustedAppPath ?? '', keychainPath ?? ''])
      const trusted = trustedAppPath ? ` -T "${trustedAppPath}"` : ''
      const keychain = keychainPath ? ` "${keychainPath}"` : ''
      // Why `-i` over argv: the secret stays out of the process table.
      const result = runProcessSync({
        program: SECURITY,
        args: ['-i'],
        input: `add-generic-password -s "${service}" -a "${account}" -w "${secret}"${trusted}${keychain}\n`,
        timeoutMs: COMMAND_TIMEOUT_MS
      })
      // `security -i` can exit 0 after a failed command, so confirm the item exists.
      if (result.code !== 0 || result.timedOut || !hasItem(service, account)) {
        throw new Error(`could not create keychain item "${service}": ${result.stderr.trim()}`)
      }
    }
  }
}
