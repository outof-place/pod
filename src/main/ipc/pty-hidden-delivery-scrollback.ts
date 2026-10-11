import type { GlobalSettings } from '../../shared/global-settings-types'
import { normalizeDesktopTerminalScrollbackRows } from '../../shared/terminal-scrollback-policy'

/** Scrollback main's per-PTY model keeps: HeadlessEmulator's default depth. */
export const MAIN_TERMINAL_MODEL_SCROLLBACK_ROWS = 5_000

/** Whether the pane's configured scrollback is deeper than main's model, so a view restored
 *  from that model on reveal would lose rows its own xterm keeps. */
export function exceedsMainTerminalModelScrollback(
  settings: Partial<Pick<GlobalSettings, 'terminalScrollbackRows'>> | null | undefined
): boolean {
  return (
    normalizeDesktopTerminalScrollbackRows(settings?.terminalScrollbackRows) >
    MAIN_TERMINAL_MODEL_SCROLLBACK_ROWS
  )
}
