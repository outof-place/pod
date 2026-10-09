// Fork-only (Pod): the native Ghostty terminal is a regular Terminal setting in Pod, on by
// default, instead of an Experimental toggle. Pod's own copy is English only.
import { getProductUiIdentity } from '@/lib/product-ui-identity'
import { getExperimentalSearchEntry } from './experimental-search'
import type { SettingsSearchEntry } from './settings-search'

export const POD_NATIVE_TERMINAL_SEARCH_ENTRY: SettingsSearchEntry = {
  title: 'Native terminal (Ghostty, Metal)',
  description:
    'Draws newly opened terminal panes with a native Ghostty view (Metal) instead of the web renderer. The web terminal stays underneath for search, copy and anything shown on top of the pane.',
  keywords: ['terminal', 'native', 'ghostty', 'metal', 'renderer', 'rendering']
}

// Why macOS only: the native view is a Ghostty NSView overlay.
export function isPodNativeTerminalSetting(): boolean {
  return (
    getProductUiIdentity() !== null &&
    typeof navigator !== 'undefined' &&
    navigator.userAgent.includes('Mac')
  )
}

export function getPodNativeTerminalSearchEntries(): SettingsSearchEntry[] {
  return isPodNativeTerminalSetting() ? [POD_NATIVE_TERMINAL_SEARCH_ENTRY] : []
}

// Why: in Pod the switch lives under Terminal, so a search must not lead to Experimental for it.
export function withoutExperimentalNativeTerminalEntry(
  entries: SettingsSearchEntry[]
): SettingsSearchEntry[] {
  if (!isPodNativeTerminalSetting()) {
    return entries
  }
  const { title } = getExperimentalSearchEntry().nativeTerminal
  return entries.filter((entry) => entry.title !== title)
}
