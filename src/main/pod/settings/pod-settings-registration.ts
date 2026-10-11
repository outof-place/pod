// Fork-only (Pod): the settings handlers registered once per store, whoever asks first.
import type { Store } from '../../persistence'
import type { AgentAwakeService } from '../../agent-awake-service'
import { registerSettingsHandlers } from '../../ipc/settings'

const registered = new WeakSet<Store>()

/**
 * podSettings registers the settings handlers at startup (headless serve opens no window); the
 * window's own registration for the same store then adds nothing.
 */
export function registerSettingsHandlersOnce(
  store: Store,
  agentAwakeService?: AgentAwakeService
): void {
  if (registered.has(store)) {
    return
  }
  registered.add(store)
  registerSettingsHandlers(store, agentAwakeService)
}
