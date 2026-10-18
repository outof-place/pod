// Fork-only (Pod): the name a person gave a terminal tab (`customTitle`), as every session-tab
// surface carries it. Every writer of a surface goes through here, so no surface drops the name.
import type { RuntimeMobileSessionSnapshotTab } from './runtime-types'

/** A given name as surfaces carry it: trimmed, none when blank. */
export function givenTabName(name: string | null | undefined): string | undefined {
  return name?.trim() || undefined
}

/** The `customTitle` a surface spreads in; empty when the tab has no name. */
export function customTitleField(name: string | null | undefined): { customTitle?: string } {
  const customTitle = givenTabName(name)
  return customTitle ? { customTitle } : {}
}

/** The name a snapshot's surfaces carry for a tab, read from any of its leaves. */
export function customTitleOfTab(
  snapshot: { tabs: readonly RuntimeMobileSessionSnapshotTab[] } | undefined,
  parentTabId: string
): string | undefined {
  for (const tab of snapshot?.tabs ?? []) {
    const name =
      tab.type === 'terminal' && tab.parentTabId === parentTabId
        ? givenTabName(tab.customTitle)
        : undefined
    if (name) {
      return name
    }
  }
  return undefined
}
