// Fork-only (Pod): podSettings.* writes through settings:set's own path; off without Pod's identity.
import type { Store } from '../../persistence'
import type { AgentAwakeService } from '../../agent-awake-service'
import { getProductIdentity } from '../../product-identity/product-identity'
import { PodSettingsService, setPodSettingsService } from './pod-settings-service'
import { registerSettingsHandlersOnce } from './pod-settings-registration'
import { getPodSettingsWriter } from './pod-settings-writer'

function hasPodProductIdentity(): boolean {
  try {
    return getProductIdentity() !== null
  } catch {
    return false
  }
}

/** Pod builds serve podSettings.*; upstream Orca doesn't. `POD_SETTINGS_RPC=0|1` overrides, for tests. */
export function isPodSettingsRpcEnabled(
  env: NodeJS.ProcessEnv = process.env,
  hasIdentity: () => boolean = hasPodProductIdentity
): boolean {
  if (env.POD_SETTINGS_RPC === '0') {
    return false
  }
  return env.POD_SETTINGS_RPC === '1' || hasIdentity()
}

export function installPodSettings(store: Store, agentAwakeService?: AgentAwakeService): void {
  if (!isPodSettingsRpcEnabled()) {
    return
  }
  // Headless serve opens no window, so settings:set and its write path exist only once registered
  // here; a window's own registration later adds nothing.
  registerSettingsHandlersOnce(store, agentAwakeService)
  setPodSettingsService(
    new PodSettingsService(store, async (values) => {
      const write = getPodSettingsWriter()
      if (!write) {
        throw new Error('Pod settings have no write path yet.')
      }
      return write(values)
    })
  )
}
