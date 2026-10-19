// Fork-only (Pod): agent text Pod pastes on the user's behalf (a startup draft, a follow-up), in one
// bracketed paste of plain text: nothing in it can end the paste or drive the agent's TUI. Shared so
// main's host writes and the classic window's writes send the same bytes.
import {
  AGENT_PROMPT_BRACKETED_PASTE_END,
  AGENT_PROMPT_BRACKETED_PASTE_START
} from './agent-prompt-injection'

/**
 * The same bytes as PodNative's AgentPromptText.sanitized: a newline stays, a tab becomes a space,
 * and every other C0 control (CR and ESC included), DEL and C1 go.
 */
export function sanitizeStartupPasteText(text: string): string {
  // oxlint-disable-next-line no-control-regex -- the controls are what this removes.
  return text.replace(/\t/g, ' ').replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '')
}

export function buildStartupPaste(text: string): string {
  return `${AGENT_PROMPT_BRACKETED_PASTE_START}${sanitizeStartupPasteText(text)}${AGENT_PROMPT_BRACKETED_PASTE_END}`
}
