// Fork-only (Pod): claude-acc owns Claude accounts, so Pod's own account actions refuse and a
// host selection left from before (which halts claude-acc's switching) is cleared at start.
import type { ClaudeAccountStore } from '../../claude-accounts/claude-account-selection'
import type { ClaudeAccountService } from '../../claude-accounts/service'
import { getProductIdentity } from '../../product-identity/product-identity'
import { PodClaudeAccountsManagedError } from '../../../shared/pod-claude-accounts-managed'

/** Every ClaudeAccountService call that signs in to, selects or removes a Pod profile. */
export const POD_REFUSED_CLAUDE_ACCOUNT_CALLS = [
  'addAccount',
  'reauthenticateAccount',
  'beginSignIn',
  'finishSignIn',
  'cancelSignIn',
  'removeAccount',
  'selectAccount',
  'selectAccountForTarget'
] as const satisfies readonly (keyof ClaudeAccountService)[]

/** RPC, IPC and the CLI all reach accounts through this service; reads stay as they are. */
export function podGuardClaudeAccounts(
  service: ClaudeAccountService,
  isPod = getProductIdentity() !== null
): ClaudeAccountService {
  if (isPod) {
    for (const name of POD_REFUSED_CLAUDE_ACCOUNT_CALLS) {
      Object.defineProperty(service, name, {
        value: () => Promise.reject(new PodClaudeAccountsManagedError())
      })
    }
  }
  return service
}

/** WSL picks stay: claude-acc runs only on the macOS host. Profiles and Keychain items stay too. */
export function clearPodClaudeHostSelection(
  store: ClaudeAccountStore,
  isPod = getProductIdentity() !== null,
  log: (message: string) => void = (message) => console.log(`[pod] ${message}`)
): boolean {
  if (!isPod) {
    return false
  }
  const settings = store.getSettings()
  const host = settings.activeClaudeManagedAccountIdsByRuntime?.host ?? null
  const legacy = settings.activeClaudeManagedAccountId ?? null
  if (host === null && legacy === null) {
    return false
  }
  store.updateSettings({
    activeClaudeManagedAccountId: null,
    activeClaudeManagedAccountIdsByRuntime: {
      host: null,
      wsl: { ...settings.activeClaudeManagedAccountIdsByRuntime?.wsl }
    }
  })
  log(
    `cleared Pod's Claude account selection (host ${host ?? 'none'}, legacy ${legacy ?? 'none'}): claude-acc picks the account`
  )
  return true
}
