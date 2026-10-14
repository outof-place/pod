// Fork-only (Pod): claude-acc owns Claude accounts, so Pod's own account actions refuse. The stored
// selection itself is handled beside the router (claude-accounts/pod-claude-host-selection.ts).
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
