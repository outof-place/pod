// Fork-only (Pod): the name a person gave a terminal tab reaches every client on each of its
// surfaces (`customTitle`), so PodNative, the phone and Pod's window name the tab alike.
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-session-contracts'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../shared/runtime-types'
import { customTitleField, givenTabName } from '../../../shared/session-tab-custom-title'

/** The snapshot's names, by tab, on every surface of the tab the client gets. */
export function withPodTabCustomTitles(
  snapshot: RuntimeMobileSessionTabsSnapshot,
  result: RuntimeMobileSessionTabsResult
): RuntimeMobileSessionTabsResult {
  let names: Map<string, string> | null = null
  for (const tab of snapshot.tabs) {
    const name = tab.type === 'terminal' ? givenTabName(tab.customTitle) : undefined
    if (tab.type === 'terminal' && name) {
      names ??= new Map()
      names.set(tab.parentTabId, name)
    }
  }
  if (!names) {
    return result
  }
  const tabs = result.tabs.map((tab) => {
    const name = tab.type === 'terminal' ? names.get(tab.parentTabId) : undefined
    return name ? { ...tab, ...customTitleField(name) } : tab
  })
  return { ...result, tabs }
}
