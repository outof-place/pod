// Fork-only (Pod): the gate on prompt text a launch types into the user's shell. No quoter escapes
// a control byte (^C/^U discard the line, CR submits, ESC/TAB act as keys), and a canonical-mode
// write past MAX_CANON is cut, which can split a quote; such text is pasted into the agent instead.

/** The code a launch refuses with; the RPC layer passes it through to callers. */
export const AGENT_PROMPT_NEEDS_PASTE_CODE = 'agent_prompt_needs_paste' as const

/** Half of macOS MAX_CANON (1024): the longest typed line that survived every measured
 *  canonical-mode write. Also the cap on each line of a multi-line one. */
export const TYPED_STARTUP_LINE_PROMPT_BUDGET_BYTES = 512

export type TypedLineRefusal = 'control-byte' | 'multi-line' | 'line-too-long'

export class AgentPromptNeedsPasteError extends Error {
  readonly code = AGENT_PROMPT_NEEDS_PASTE_CODE
  /** Sent as the RPC error's `data`. */
  readonly data: { reason: TypedLineRefusal }
  constructor(readonly reason: TypedLineRefusal) {
    super(AGENT_PROMPT_NEEDS_PASTE_CODE)
    this.name = 'AgentPromptNeedsPasteError'
    this.data = { reason }
  }
}

export function isAgentPromptNeedsPasteError(error: unknown): error is AgentPromptNeedsPasteError {
  return error instanceof AgentPromptNeedsPasteError
}

const encoder = new TextEncoder()

/** C0 but LF, DEL, and C1 (U+0080–U+009F, which a UTF-8 terminal may take as escapes). */
function isRefusedControl(code: number): boolean {
  return (code < 0x20 && code !== 0x0a) || code === 0x7f || (code >= 0x80 && code <= 0x9f)
}

/** Why a launch `line` with a prompt on it can't be typed, or null when it can. Read on the built
 *  line: a quoter that escapes a byte (PowerShell's `n) leaves nothing for the shell to act on. A
 *  raw newline is allowed only with `multiLine`, where the caller checked the shell reads it whole. */
export function typedLineRefusal(
  line: string,
  opts: { multiLine: boolean }
): TypedLineRefusal | null {
  for (let i = 0; i < line.length; i += 1) {
    if (isRefusedControl(line.charCodeAt(i))) {
      return 'control-byte'
    }
  }
  if (!opts.multiLine && line.includes('\n')) {
    return 'multi-line'
  }
  for (const part of line.split('\n')) {
    if (encoder.encode(part).byteLength > TYPED_STARTUP_LINE_PROMPT_BUDGET_BYTES) {
      return 'line-too-long'
    }
  }
  return null
}

/** Text a host pastes into an agent: line breaks become LF, and every other control byte the gate
 *  refuses becomes its visible stand-in (U+2400 block, U+2421 for DEL, U+FFFD for C1), so no byte
 *  of the paste but a line break can act as a key, even on a receiver outside bracketed paste. */
export function neutralizePastedControls(text: string): string {
  let out = ''
  for (const char of text.replace(/\r\n?/g, '\n')) {
    const code = char.charCodeAt(0)
    if (code === 0x0a || !isRefusedControl(code)) {
      out += char
    } else if (code < 0x20) {
      out += String.fromCharCode(0x2400 + code)
    } else {
      out += code === 0x7f ? '\u2421' : '\ufffd'
    }
  }
  return out
}

/** Throws `agent_prompt_needs_paste` unless `line` can be typed; nothing is typed then. */
export function assertTypedLineCarries(line: string, opts: { multiLine: boolean }): void {
  const refusal = typedLineRefusal(line, opts)
  if (refusal) {
    throw new AgentPromptNeedsPasteError(refusal)
  }
}
