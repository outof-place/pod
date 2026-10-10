import { homedir } from 'node:os'
import { describeClaudeProfile } from './claude-profile-paths'
import { claudeConfigDirSpellings, claudeKeychainService } from './keychain'

const HOST = { executionHostId: 'local', runtime: 'host' } as const

/**
 * The Keychain services Claude files a host profile's sign-in under: `canonical` from the one
 * spelling launches pass as CLAUDE_CONFIG_DIR, `spellings` from every spelling Claude may have
 * hashed. Both depend on the data root, so a profile copied to another root needs its own item.
 */
export function claudeProfileKeychainServices(
  dataRoot: string,
  accountId: string,
  userHome: string = homedir()
): { canonical: string; spellings: string[] } {
  const { home } = describeClaudeProfile(dataRoot, accountId, HOST)
  return {
    canonical: claudeKeychainService(home),
    spellings: [
      ...new Set(
        claudeConfigDirSpellings(home, userHome).map((spelling) => claudeKeychainService(spelling))
      )
    ]
  }
}
