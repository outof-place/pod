import { extractLastOscTitle } from '../../shared/osc-title-extraction'
import { resolveTerminalTitleAgentType } from '../../shared/terminal-title-agent-type'

/**
 * Fork-only (Pod): whether a model chunk goes through Freebuff's screen-status scan (frame
 * splitting plus composer reads). Freebuff's own titles name no agent, so the scan runs while the
 * pane's title is unknown and stops only under another agent's title. A Claude pane frames every
 * redraw (?2026l), so the split multiplied its model writes and scans.
 */
export function podScansForFreebuff(chunk: string, lastTitle: string | null): boolean {
  const title = (chunk.includes('\x1b]') ? extractLastOscTitle(chunk) : null) ?? lastTitle
  return !title || resolveTerminalTitleAgentType(title) === null
}
