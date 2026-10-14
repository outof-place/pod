// Fork-only (Pod): claude-acc owns Claude accounts, and a host selection (which halts claude-acc's
// switching) must not survive or come back: cleared at start, dropped from generic settings writes.
import type { GlobalSettings } from '../../shared/global-settings-types'
import { getProductIdentity } from '../product-identity/product-identity'
import type { ClaudeAccountStore } from './claude-account-selection'

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

let loggedSelectionDrop = false

/** settings:set and podSettings.set take any partial: none may store a host selection in Pod. */
export function podDropClaudeHostSelection(
  args: Partial<GlobalSettings>,
  isPod = getProductIdentity() !== null,
  log: (message: string) => void = (message) => console.log(`[pod] ${message}`)
): Partial<GlobalSettings> {
  if (
    !isPod ||
    !('activeClaudeManagedAccountId' in args || 'activeClaudeManagedAccountIdsByRuntime' in args)
  ) {
    return args
  }
  const next = { ...args }
  delete next.activeClaudeManagedAccountId
  if (next.activeClaudeManagedAccountIdsByRuntime) {
    next.activeClaudeManagedAccountIdsByRuntime = {
      host: null,
      wsl: { ...next.activeClaudeManagedAccountIdsByRuntime.wsl }
    }
  }
  if (!loggedSelectionDrop) {
    loggedSelectionDrop = true
    log('dropped a Claude account selection from a settings update; claude-acc picks the account')
  }
  return next
}
