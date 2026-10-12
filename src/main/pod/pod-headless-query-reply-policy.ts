import type { TuiAgent } from '../../shared/tui-agent'
import { resolveTerminalTitleAgentType } from '../../shared/terminal-title-agent-type'

/* oxlint-disable no-control-regex -- an XTVERSION reply is a DCS control sequence */
const XTVERSION_REPLY = new RegExp('^\u001bP>\\|[^\u001b]*\u001b\\\\$')
/* oxlint-enable no-control-regex */
const POD_XTVERSION_REPLY = '\u001bP>|Pod\u001b\\'

export type PodQueryReplyTerminal = {
  launchAgent: TuiAgent | null | undefined
  /** The model's last OSC 0/2 title. A hand-typed `claude` sets it before it probes and clears it on
   *  exit; the foreground process can't tell: a native Claude's kernel name is its version file. */
  title: string | null | undefined
}

/**
 * Fork-only (Pod): the headless model's reply as a hidden Claude Code terminal gets it.
 * Claude reads XTVERSION once, at startup. `xterm.js` (the model's engine) keeps it in its xterm.js /
 * VS Code mode for the whole session, though Ghostty shows the tab later: no click-to-open on links,
 * an OSC 104;255 atlas reset on every focus and redraw. No reply is worse: an unnamed terminal skips
 * Claude's capability probe, so it never uses synchronized output. The model answers as Pod instead.
 */
export function podHeadlessQueryReply(terminal: PodQueryReplyTerminal, reply: string): string {
  if (!XTVERSION_REPLY.test(reply)) {
    return reply
  }
  const claude =
    terminal.launchAgent === 'claude' ||
    (!!terminal.title && resolveTerminalTitleAgentType(terminal.title) === 'claude')
  return claude ? POD_XTVERSION_REPLY : reply
}
