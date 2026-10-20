// Fork-only (Pod): terminal settings podSettings shows as the desktop reads them.
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { normalizeTerminalColorOverrides } from '../../../shared/terminal-custom-themes'

export function storedTerminalSetting(
  settings: GlobalSettings,
  key: 'terminalLinkClickBehavior' | 'terminalColorOverrides'
): unknown {
  if (key === 'terminalColorOverrides') {
    // The window stores a typed color at each keystroke; the valid ones stay shown.
    return settings.terminalColorOverrides === undefined
      ? undefined
      : normalizeTerminalColorOverrides(settings.terminalColorOverrides)
  }
  // The renderer's terminalLinkClickBehaviorFor: a profile from before this setting kept only
  // the popover switch.
  const behavior = settings.terminalLinkClickBehavior
  if (behavior === 'open' || behavior === 'none') {
    return behavior
  }
  return settings.terminalLinkActionPopoverEnabled === false ? 'none' : 'actions'
}
