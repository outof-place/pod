import { extractLastOscTitle } from '../../shared/osc-title-extraction'
import { resolveTerminalTitleAgentType } from '../../shared/terminal-title-agent-type'
import { memoizeTitleClassification } from '../../shared/terminal-title-classification-memo'

// Why memoized: the model's last title rides along with every chunk; classifying it each time cost
// more than the scan it saves.
const titleNamesAgent = memoizeTitleClassification(
  (title: string) => resolveTerminalTitleAgentType(title) !== null
)

/**
 * Fork-only (Pod): whether a model chunk goes through Freebuff's screen-status scan (frame
 * splitting plus composer reads). Freebuff's own titles name no agent, so the scan runs while the
 * pane's title is unknown and stops only under another agent's title. A Claude pane frames every
 * redraw (?2026l), so the split multiplied its model writes and scans.
 */
export function podScansForFreebuff(chunk: string, lastTitle: string | null): boolean {
  const title = (chunk.includes('\x1b]') ? extractLastOscTitle(chunk) : null) ?? lastTitle
  return !title || !titleNamesAgent(title)
}
