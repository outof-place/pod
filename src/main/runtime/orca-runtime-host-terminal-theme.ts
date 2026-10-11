import { OrcaRuntimeWithScheduleMobileSessionTabsChanged } from './orca-runtime-schedule-mobile-session-tabs-changed'
import type { RuntimeMobileTerminalTheme } from '../../shared/runtime-mobile-session-tab-contracts'
import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-types'
import { resolveHostTerminalTheme, sameTerminalTheme } from './runtime-host-terminal-theme'

export class OrcaRuntimeWithHostTerminalTheme extends OrcaRuntimeWithScheduleMobileSessionTabsChanged {
  private lastHostTerminalTheme: RuntimeMobileTerminalTheme | undefined

  /** The theme for terminal tabs no renderer themed (a headless host has no renderer). */
  protected getHostTerminalTheme(): RuntimeMobileTerminalTheme | undefined {
    return resolveHostTerminalTheme(this.store?.getSettings())
  }

  /** A renderer themes its terminal tabs; a headless host has none, so main fills the theme in. */
  protected withHostTerminalTheme(
    result: RuntimeMobileSessionTabsResult
  ): RuntimeMobileSessionTabsResult {
    if (!result.tabs.some((tab) => tab.type === 'terminal' && !tab.terminalTheme)) {
      return result
    }
    const terminalTheme = this.getHostTerminalTheme()
    if (!terminalTheme) {
      return result
    }
    return {
      ...result,
      tabs: result.tabs.map((tab) =>
        tab.type === 'terminal' && !tab.terminalTheme ? { ...tab, terminalTheme } : tab
      )
    }
  }

  /** Settings or the system appearance moved: snapshots that carry the host's theme go out again. */
  refreshHostTerminalTheme(): void {
    const theme = this.getHostTerminalTheme()
    if (sameTerminalTheme(theme, this.lastHostTerminalTheme)) {
      return
    }
    this.lastHostTerminalTheme = theme
    for (const [worktreeId, snapshot] of this.mobileSessionTabsByWorktree) {
      if (snapshot.tabs.some((tab) => tab.type === 'terminal' && !tab.terminalTheme)) {
        this.republishMobileSessionTabsSnapshot(worktreeId)
      }
    }
  }
}
