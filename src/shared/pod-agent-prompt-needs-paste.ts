// Fork-only (Pod): a startup line Pod will not type. Only staging delivers it whole (a typed line
// past MAX_CANON is cut, and a raw newline is Enter), and staging cannot run for it here: its shell
// does not source a staged script, or the script could not be written. Refused before any tab or
// PTY exists, so the client creates the terminal without the prompt and pastes the prompt instead.

export const AGENT_PROMPT_NEEDS_PASTE_CODE = 'agent_prompt_needs_paste'

/** Why the line needed staging. For the client's message only. */
export type AgentPromptNeedsPasteReason = 'control-byte' | 'multi-line' | 'line-too-long'

export class AgentPromptNeedsPasteError extends Error {
  readonly code = AGENT_PROMPT_NEEDS_PASTE_CODE
  readonly data: { reason: AgentPromptNeedsPasteReason }

  constructor(reason: AgentPromptNeedsPasteReason) {
    super(AGENT_PROMPT_NEEDS_PASTE_CODE)
    this.name = 'AgentPromptNeedsPasteError'
    this.data = { reason }
  }
}
