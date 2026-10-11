import { getSystemPrefersDark } from '@/lib/terminal-theme'
import type { AppState } from '@/store/types'
import type { RuntimeMobileTerminalTheme } from '../../../../shared/runtime-types'
import { resolveRuntimeTerminalTheme } from '../../../../shared/runtime-terminal-theme'
import { graphState } from './graph-state'

export function resolveMobileTerminalTheme(
  state: AppState,
  systemPrefersDark: boolean
): RuntimeMobileTerminalTheme | undefined {
  return state.settings ? resolveRuntimeTerminalTheme(state.settings, systemPrefersDark) : undefined
}

export function getMobileTerminalTheme(
  state: AppState,
  systemPrefersDark = getSystemPrefersDark()
): RuntimeMobileTerminalTheme | undefined {
  if (
    graphState.hasCachedMobileTerminalTheme &&
    graphState.cachedMobileTerminalThemeSettings === state.settings &&
    graphState.cachedMobileTerminalThemeSystemPrefersDark === systemPrefersDark
  ) {
    return graphState.cachedMobileTerminalTheme
  }
  graphState.cachedMobileTerminalTheme = resolveMobileTerminalTheme(state, systemPrefersDark)
  graphState.cachedMobileTerminalThemeSettings = state.settings
  graphState.cachedMobileTerminalThemeSystemPrefersDark = systemPrefersDark
  graphState.hasCachedMobileTerminalTheme = true
  return graphState.cachedMobileTerminalTheme
}
