import type { GlobalSettings } from '../../../../../shared/global-settings-types'

export function isNativeTerminalRequested(settings: GlobalSettings | null | undefined): boolean {
  return (
    settings?.experimentalNativeTerminal === true &&
    typeof navigator !== 'undefined' &&
    navigator.userAgent.includes('Mac')
  )
}

// Parse once: main's model, not this xterm, answers a covered pane's queries.
export function isNativeTerminalParseOnceRequested(
  settings: GlobalSettings | null | undefined
): boolean {
  return (
    isNativeTerminalRequested(settings) &&
    settings?.experimentalNativeTerminalParseOnce === true &&
    settings.terminalModelQueryAuthority !== false
  )
}
